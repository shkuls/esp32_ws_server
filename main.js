const WebSocket = require('ws');
const speech = require('@google-cloud/speech');
const OpenAI = require('openai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const {LRUCache} = require('lru-cache'); // add with: npm install lru-cache
require('dotenv').config();

// Eleven Labs API Integration
const axios = require('axios'); // add with: npm install axios

// Create a WebSocket server with optimized settings
const wss = new WebSocket.Server({
  port: 8080,
  perMessageDeflate: {
    zlibDeflateOptions: { level: 6, memLevel: 8 },
    serverNoContextTakeover: true,
    clientNoContextTakeover: true
  },
  maxPayload: 16 * 1024 * 1024 // 16MB max payload
});

// Create service clients
const speechClient = new speech.SpeechClient();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 2 // Reduce retry attempts for faster error response
});

// Configuration for speech recognition
const speechConfig = {
  config: {
    encoding: 'LINEAR16',
    sampleRateHertz: 16000,
    languageCode: 'en-IN',
    enableAutomaticPunctuation: true,
    model: 'default',
    useEnhanced: true
  },
  interimResults: true
};

// Flag to track if system is speaking (simulated)
let isSpeaking = false;

// Setup cache directories
const RESPONSE_CACHE_DIR = path.join(__dirname, 'response_cache');
const AUDIO_CACHE_DIR = path.join(__dirname, 'audio_cache');

if (!fs.existsSync(RESPONSE_CACHE_DIR)) {
  fs.mkdirSync(RESPONSE_CACHE_DIR, { recursive: true });
}

if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}

// In-memory LRU cache for ultra-fast response caching
// This complements file-based caching
const memoryCache = new LRUCache({
  max: 500, // Store up to 500 responses
  maxSize: 5 * 1024 * 1024, // Use maximum 5MB memory for cache
  sizeCalculation: (value, key) => {
    return JSON.stringify(value).length;
  },
  ttl: 1000 * 60 * 60, // 1 hour TTL
  updateAgeOnGet: true, // Items accessed recently stay in cache longer
  allowStale: true // Allow using stale cached items while refreshing
});

// Utility functions
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);
const readDirAsync = util.promisify(fs.readdir);

// Faster hash function (xxhash would be even better if available)
function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

// Warm up the memory cache from disk on startup
async function warmupCache() {
  try {
    console.log("Warming up cache from disk...");
    const files = await readDirAsync(RESPONSE_CACHE_DIR);
    const now = Date.now();
    
    // Only load recent cache entries (last day)
    const recentFiles = files.filter(file => {
      try {
        const stats = fs.statSync(path.join(RESPONSE_CACHE_DIR, file));
        return (now - stats.mtime.getTime()) < 24 * 60 * 60 * 1000;
      } catch (err) {
        return false;
      }
    }).slice(0, 100); // Limit to 100 most recent files to avoid startup delays
    
    for (const file of recentFiles) {
      try {
        const filePath = path.join(RESPONSE_CACHE_DIR, file);
        const data = JSON.parse(await readFileAsync(filePath, 'utf8'));
        memoryCache.set(file.replace('.json', ''), data);
      } catch (err) {
        // Ignore corrupt cache files
      }
    }
    console.log(`Loaded ${memoryCache.size} cached responses into memory.`);
  } catch (err) {
    console.error("Error warming cache:", err);
  }
}

// Call warmup at server start
warmupCache();

// Function to stream cached audio files to ESP32
function streamCachedAudioToESP32(audioFilePath, ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log("Client WebSocket not open, can't stream audio");
    return;
  }
  
  try {
    // Notify ESP32 that audio stream is starting
    ws.send(JSON.stringify({
      type: 'audio_start',
      format: 'mp3'
    }));
    
    // Create read stream from the cached audio file
    const fileStream = fs.createReadStream(audioFilePath);
    let isFirstChunk = true;
    
    fileStream.on('data', (chunk) => {
      // If it's the first chunk, include audio metadata
      if (isFirstChunk) {
        ws.send(JSON.stringify({
          type: 'audio_data',
          isFirstChunk: true,
          format: 'mp3'
        }));
        isFirstChunk = false;
      }
      
      // Send binary chunk to ESP32
      ws.send(chunk);
    });
    
    fileStream.on('end', () => {
      // Notify ESP32 that audio stream has ended
      ws.send(JSON.stringify({
        type: 'audio_end'
      }));
      console.log(`Finished streaming cached audio file to ESP32: ${audioFilePath}`);
    });
    
    fileStream.on('error', (error) => {
      console.error(`Error streaming cached audio file: ${error.message}`);
      ws.send(JSON.stringify({
        type: 'audio_error',
        message: error.message
      }));
    });
  } catch (error) {
    console.error(`Error setting up file stream: ${error.message}`);
  }
}


// Optimized streaming responses for AI with TTS
async function streamingResponse(text, ws) {
  isSpeaking = true;
  
  // Notify client that we're "speaking"
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      command: 'speaking_started',
      speaking: true
    }));
  }
  
  try {
    // Try to get from cache first for immediate response
    const query = text.toLowerCase().trim();
    const cacheKey = hashText(query);
    
    // Check memory cache first
    const cachedItem = memoryCache.get(cacheKey);
    if (cachedItem) {
      console.log("🔥 Using cached response:", query);
      console.log('\n📤 RESPONSE (memory cache): ' + cachedItem.response + '\n');
      
      // Simulate brief thinking time
      await new Promise(resolve => setTimeout(resolve, 100));
      
      
      // Send response to client
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          transcript: text,
          aiResponse: cachedItem.response,
          isFinal: true
        }));
      }
      
      
      
      return;
    }
    
    // Check disk cache
    const cacheFile = path.join(RESPONSE_CACHE_DIR, `${cacheKey}.json`);
    try {
      if (fs.existsSync(cacheFile)) {
        const cachedData = JSON.parse(await readFileAsync(cacheFile, 'utf8'));
        console.log("💾 Using cached response from disk:", query);
        console.log('\n📤 RESPONSE (disk cache): ' + cachedData.response + '\n');
        
        // Update memory cache
        memoryCache.set(cacheKey, cachedData);
        
        // Generate TTS or use cached audio
        const audioCacheKey = hashText(cachedData.response);
        const audioCachePath = path.join(AUDIO_CACHE_DIR, `${audioCacheKey}.mp3`);
        
        
        
        // Send response to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            transcript: text,
            aiResponse: cachedData.response,
            isFinal: true
          }));
        }
        
        // End speaking simulation
        setTimeout(() => {
          isSpeaking = false;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              command: 'speaking_finished',
              speaking: false
            }));
          }
        }, 500);
        
        return;
      }
    } catch (cacheErr) {
      console.error("Error reading disk cache:", cacheErr);
    }
    
    console.log("⚡ Starting streaming response for:", text);
    console.time("Streaming Response Time");
    
    // Setup streaming response from API
    process.stdout.write('\n🔄 STREAMING RESPONSE: ');
    const stream = await openai.chat.completions.create({
      model: "ft:gpt-4o-mini-2024-07-18:toonbox-interactive:hindi-prototype:B70KmmqG",
      messages: [
        {
          role: "system",
          content: "You are a companion for Indian kids, answering their curious questions in a short, engaging and educational way with positive reinforcement. Use Hinglish or English based on the question, keeping English words in English and हिंदी words in हिंदी. Avoid explicit or inappropriate content."
        },
        { role: "user", content: text }
      ],
      stream: true,
      temperature: 0.3,
      max_tokens: 150,
    });
    
    // Track complete response
    let completeResponse = "";
    let chunks = [];
    
    // Process streaming output
    for await (const chunk of stream) {
      if (!isSpeaking) {
        // Interrupted, stop processing stream
        stream.controller.abort();
        break;
      }
      
      const content = chunk.choices[0]?.delta?.content || "";
      process.stdout.write(content);
      completeResponse += content;
      chunks.push(content);
      
      // Send chunks to client (optional - can be removed for less traffic)
      if (content && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          transcript: text,
          aiResponseChunk: content,
          isFinal: false
        }));
      }
    }
    
    console.log('\n');
    console.timeEnd("Streaming Response Time");
    
    // Generate TTS after complete response is ready and stream to ESP32
    const audioCacheKey = hashText(completeResponse);
    
  
    
    // Send complete response to client
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        transcript: text,
        aiResponse: completeResponse,
        isFinal: true
      }));
    }
    
    // Cache the complete response
    const cacheObject = {
      query: query,
      response: completeResponse,
      timestamp: Date.now()
    };
    
    memoryCache.set(cacheKey, cacheObject);
    
    // Write to disk cache asynchronously
    writeFileAsync(cacheFile, JSON.stringify(cacheObject))
      .catch(err => console.error("Error writing cache file:", err));
    
    // End speaking simulation
    setTimeout(() => {
      isSpeaking = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          command: 'speaking_finished',
          speaking: false
        }));
      }
    }, 300);
    
  } catch (error) {
    console.error("Error in streaming response:", error);
    isSpeaking = false;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        command: 'speaking_finished',
        speaking: false
      }));
    }
  }
}

// Server initialization
wss.on('listening', () => {
  console.log(`WebSocket server is running on:`);
  const interfaces = os.networkInterfaces();
  Object.values(interfaces).forEach(iface => {
    iface.forEach(addr => {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`- ws://${addr.address}:${8080} `);
      }
    });
  });
});

// Client connection handler
wss.on('connection', (ws) => {
  console.log('🔌 ESP32 device connected');
  let recognizeStream = null;
  let isStreamActive = false;
  let audioBufferPool = [];
  let audioBufferCount = 0;
  
  // Setup ping/pong for connection stability
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
  
  // Recognition stream initialization
  function startRecognitionStream() {
    if (isSpeaking) {
      console.log('⏳ Recognition start delayed - system is busy');
      return;
    }
    
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
    }
    
    isStreamActive = false;
    console.log('🎤 Starting new recognition stream...');
    
    recognizeStream = speechClient
      .streamingRecognize(speechConfig)
      .on('error', (error) => {
        console.error('❌ Recognition stream error:', error);
        isStreamActive = false;
        
        if (!isSpeaking) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              startRecognitionStream();
            }
          }, 2000);
        }
      })
      .on('data', async (data) => {
        if (isSpeaking) return;
        
        const transcript = data.results[0].alternatives[0].transcript;
        const isFinal = data.results[0].isFinal;
        
        console.log(`🎙️ Transcript: "${transcript}" ${isFinal ? '[FINAL]' : '[interim]'}`);
        
        if (isFinal && transcript.trim().length > 0) {
          console.log("✅ Processing final transcript:", transcript);
          
          // Send transcript to client immediately
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              transcript: transcript,
              isFinal: true
            }));
          }
          
          // Generate and stream response
          await streamingResponse(transcript, ws);
        } else if (!isFinal) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              transcript: transcript,
              isFinal: false
            }));
          }
        }
      })
      .on('end', () => {
        console.log('🛑 Recognition stream ended');
        isStreamActive = false;
      });
    
    isStreamActive = true;
    console.log('✅ Speech recognition stream started');
  }
  
  // Message handler
  ws.on('message', (message) => {
    if (typeof message === 'string') {
      const command = message.toString();
      console.log(`📩 Command received: ${command}`);
      
      if (command === 'start' && !isSpeaking) {
        startRecognitionStream();
        ws.send('start');
      } else if (command === 'stop') {
        if (recognizeStream) {
          recognizeStream.end();
          recognizeStream = null;
          isStreamActive = false;
        }
        console.log('🛑 Recognition stopped');
      } else if (command === 'interrupt') {
        console.log('⏹️ Received interrupt command');
        isSpeaking = false;
        
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN && !isStreamActive && !isSpeaking) {
            startRecognitionStream();
          }
        }, 300);
      }
    } else {
      // Binary audio data
      audioBufferCount++;
      
      // Occasionally log audio buffer stats
      if (audioBufferCount % 50 === 0) {
        // console.log(`🔊 Processed ${audioBufferCount} audio buffers`);
      }
      
      if (isSpeaking) {
        return; // Skip audio processing while speaking
      }
      
      if (!isStreamActive) {
        startRecognitionStream();
      }
      
      if (recognizeStream) {
        try {
          recognizeStream.write(message);
        } catch (err) {
          console.error('❌ Error writing to stream:', err);
          startRecognitionStream();
        }
      }
    }
  });
  
  // Connection close handler
  ws.on('close', () => {
    console.log('🔌 ESP32 device disconnected');
    clearInterval(pingInterval);
    
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
      isStreamActive = false;
    }
    
    // Clear audio buffer pool
    audioBufferPool = [];
  });
  
  // Error handler
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
  
  // Start recognition after connection
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN && !isSpeaking) {
      startRecognitionStream();
      ws.send('start');
    }
  }, 1000);
});

// Memory usage monitoring and optimization
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(`📊 Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
  
  // Force garbage collection if memory usage is high and global.gc is available
  if (global.gc && memUsage.heapUsed > 500 * 1024 * 1024) {
    global.gc();
    console.log('🧹 Forced garbage collection');
  }
}, 60000);

// Cache cleanup (once per day)
setInterval(() => {
  try {
    console.log("🧹 Running cache cleanup...");
    const now = Date.now();
    
    // Clean response cache
    const responseFiles = fs.readdirSync(RESPONSE_CACHE_DIR);
    let cleanedResponses = 0;
    
    responseFiles.forEach(file => {
      const filePath = path.join(RESPONSE_CACHE_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        // Remove files older than 7 days
        if (now - stats.mtime.getTime() > 7 * 24 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          cleanedResponses++;
        }
      } catch (err) {
        // Ignore errors for individual files
      }
    });
    
    // Clean audio cache
    const audioFiles = fs.readdirSync(AUDIO_CACHE_DIR);
    let cleanedAudio = 0;
    
    audioFiles.forEach(file => {
      const filePath = path.join(AUDIO_CACHE_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        // Remove files older than 7 days
        if (now - stats.mtime.getTime() > 7 * 24 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          cleanedAudio++;
        }
      } catch (err) {
        // Ignore errors for individual files
      }
    });
    
    console.log(`🧹 Cache cleanup complete. Removed ${cleanedResponses} response files and ${cleanedAudio} audio files.`);
  } catch (err) {
    console.error("❌ Error during cache cleanup:", err);
  }
}, 24 * 60 * 60 * 1000); // Once per day

console.log('Press Ctrl+C to exit');
