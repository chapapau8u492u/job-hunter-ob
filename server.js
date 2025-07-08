
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB configuration
const uri = "mongodb+srv://chapapau8u492u:chapapau8u492u@job-hunter.nh5pqhk.mongodb.net/?retryWrites=true&w=majority&appName=Job-Hunter";
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;
let applicationsCollection;

// Initialize MongoDB connection
async function initMongoDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB successfully!");
    
    db = client.db("jobtracker");
    applicationsCollection = db.collection("applications");
    
    // Create indexes for better performance
    await applicationsCollection.createIndex({ company: 1, position: 1, jobUrl: 1 });
    await applicationsCollection.createIndex({ createdAt: -1 });
    
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ server });

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Format job description for better readability
function formatJobDescription(description) {
  if (!description) return '';
  
  let formatted = description
    // Clean up extra whitespace
    .replace(/\s+/g, ' ')
    .trim()
    // Add proper line breaks before common section headers
    .replace(/(responsibilities|requirements|qualifications|skills|benefits|about)/gi, '\n\n$1')
    // Convert bullet patterns to proper bullets
    .replace(/[•·▪▫◦‣⁃]/g, '•')
    .replace(/[-*]\s/g, '• ')
    // Add spacing around bullets
    .replace(/•/g, '\n• ')
    // Clean up multiple line breaks
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    // Capitalize section headers
    .replace(/\n\n(responsibilities|requirements|qualifications|skills|benefits|about)/gi, 
             (match, word) => `\n\n${word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()}`)
    .trim();
  
  return formatted;
}

// Validate and sanitize job data
function validateJobData(jobData) {
  const sanitized = {
    company: (jobData.company || '').trim(),
    position: (jobData.position || '').trim(),
    location: (jobData.location || '').trim(),
    salary: (jobData.salary || '').trim(),
    jobUrl: (jobData.jobUrl || '').trim(),
    description: formatJobDescription(jobData.description || ''),
    appliedDate: jobData.appliedDate || new Date().toISOString().split('T')[0],
    status: jobData.status || 'Applied',
    notes: (jobData.notes || '').trim()
  };
  
  // Validate required fields
  if (!sanitized.company && !sanitized.position) {
    throw new Error('Missing required fields: company or position');
  }
  
  return sanitized;
}

// WebSocket connection handling
wss.on('connection', async (ws) => {
  console.log('Client connected to WebSocket');
  
  try {
    // Send current applications to new client
    const applications = await applicationsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    
    ws.send(JSON.stringify({
      type: 'INITIAL_DATA',
      applications: applications
    }));
  } catch (error) {
    console.error('Error sending initial data:', error);
  }
  
  ws.on('close', () => {
    console.log('Client disconnected from WebSocket');
  });
});

// API Routes

// Get all applications
app.get('/api/applications', async (req, res) => {
  try {
    const applications = await applicationsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    
    res.json({ success: true, applications });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch applications'
    });
  }
});

// Sync applications - get new applications not in frontend
app.post('/api/applications/sync', async (req, res) => {
  try {
    const { frontendApplications = [] } = req.body;
    
    // Get all applications from MongoDB
    const allApplications = await applicationsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    
    // Create a set of frontend application IDs for quick lookup
    const frontendIds = new Set(frontendApplications.map(app => app.id));
    
    // Find new applications not in frontend
    const newApplications = allApplications.filter(app => !frontendIds.has(app.id));
    
    // If there are applications in frontend that are not in MongoDB, add them
    const mongoIds = new Set(allApplications.map(app => app.id));
    const applicationsToAdd = frontendApplications.filter(app => !mongoIds.has(app.id));
    
    if (applicationsToAdd.length > 0) {
      await applicationsCollection.insertMany(applicationsToAdd.map(app => ({
        ...app,
        createdAt: new Date().toISOString()
      })));
    }
    
    res.json({
      success: true,
      newApplications: newApplications,
      syncedCount: applicationsToAdd.length
    });
    
  } catch (error) {
    console.error('Error syncing applications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync applications'
    });
  }
});

// Create new application
app.post('/api/applications', async (req, res) => {
  try {
    const jobData = validateJobData(req.body);
    console.log('Received job application:', jobData);
    
    // Create new application
    const newApplication = {
      id: uuidv4(),
      ...jobData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // Check for duplicates
    const existingApp = await applicationsCollection.findOne({
      $and: [
        { company: { $regex: new RegExp(`^${jobData.company}$`, 'i') } },
        { position: { $regex: new RegExp(`^${jobData.position}$`, 'i') } },
        {
          $or: [
            { jobUrl: jobData.jobUrl },
            { $and: [{ jobUrl: { $exists: false } }, { jobUrl: '' }] }
          ]
        }
      ]
    });
    
    if (existingApp) {
      return res.status(409).json({
        success: false,
        error: 'Duplicate application',
        message: 'This application already exists'
      });
    }
    
    // Insert to MongoDB
    await applicationsCollection.insertOne(newApplication);
    
    // Broadcast to all connected clients
    broadcast({
      type: 'NEW_APPLICATION',
      application: newApplication
    });
    
    console.log('Application saved successfully:', newApplication.id);
    
    res.json({
      success: true,
      data: newApplication,
      message: 'Application saved successfully'
    });
    
  } catch (error) {
    console.error('Error saving application:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Update application
app.put('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const result = await applicationsCollection.updateOne(
      { id: id },
      { 
        $set: { 
          ...updates, 
          updatedAt: new Date().toISOString() 
        } 
      }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Application not found'
      });
    }
    
    const updatedApplication = await applicationsCollection.findOne({ id: id });
    
    // Broadcast update
    broadcast({
      type: 'APPLICATION_UPDATED',
      application: updatedApplication
    });
    
    res.json({
      success: true,
      data: updatedApplication
    });
    
  } catch (error) {
    console.error('Error updating application:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Delete application
app.delete('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await applicationsCollection.deleteOne({ id: id });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Application not found'
      });
    }
    
    // Broadcast deletion
    broadcast({
      type: 'APPLICATION_DELETED',
      applicationId: id
    });
    
    res.json({
      success: true,
      message: 'Application deleted successfully'
    });
    
  } catch (error) {
    console.error('Error deleting application:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const count = await applicationsCollection.countDocuments();
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      applications: count,
      database: 'MongoDB'
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

// Initialize and start server
async function startServer() {
  await initMongoDB();
  
  server.listen(PORT, () => {
    console.log(`JobTracker Backend running on port ${PORT}`);
    console.log(`WebSocket server ready for real-time updates`);
    console.log(`MongoDB connected to Job-Hunter cluster`);
  });
}

startServer().catch(console.error);
