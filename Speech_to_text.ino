#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>

#define WEBSOCKETS_LOGGING false

// WiFi credentials
const char* ssid = "Shlok";
const char* password = "fops6553";

// WebSocket server details
const char* wsHost = "172.20.10.3";  // Your computer's IP
const uint16_t wsPort = 8080;
const char* wsPath = "/";

// // Eleven Labs WebSocket URL (Replace with actual server URL)
// const char* elevenLabsWSURL = "api.elevenlabs.io";
// const int elevenLabsPort = 443;  // Secure WebSockets (WSS)

const char* apiKey = "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";  // Replace with your API key
const char* voiceID = "xoV6iGVuOGYHLWjXhVC7";                                                                                                                                                 // Replace with your chosen Eleven Labs voice ID
const char* elevenLabsURL = "https://api.openai.com/v1/audio/speech";
// Audio playback state
bool isPlayingTTS = false;

// WiFiClientSecure client;


WebSocketsClient webSocket;
HTTPClient http;

// Eleven Labs WebSocket configuration
WebSocketsClient elevenLabsWS;

i2s_port_t I2S_PORT = I2S_NUM_0;
i2s_port_t I2S_SPK_PORT = I2S_NUM_1;

// I2S configuration pins for INMP441
#define I2S_WS 9
#define I2S_SD 11
#define I2S_SCK 7

// New speaker I2S configuration
#define I2S_SPEAKER_BCLK 6
#define I2S_SPEAKER_LRC 7
#define I2S_SPEAKER_DOUT 5

// Sample rate and buffer configuration
#define SAMPLE_RATE 16000
#define SAMPLE_BUFFER_SIZE 512
#define I2S_MIC_CHANNEL I2S_CHANNEL_FMT_ONLY_LEFT

// Voice detection threshold for interruption
#define VOICE_THRESHOLD 2000  // Adjust based on your microphone sensitivity


// LED pins for status indication
#define LED_PIN 2         // Built-in LED for recording status
#define ERROR_LED_PIN 22  // Optional LED for error indication

WiFiClientSecure client;

bool isConnected = false;
bool isRecording = false;
bool serverIsSpeaking = false;
bool isInterrupting = false;
unsigned long lastInterruptionTime = 0;
const unsigned long interruptionCooldown = 2000;  // Cooldown period in ms


// void elevenLabsWSEvent(WStype_t type, uint8_t * payload, size_t length) {
//   switch(type) {
//     case WStype_DISCONNECTED:
//       Serial.println("Eleven Labs WebSocket disconnected");
//       elevenLabsConnected = false;
//       break;

//     case WStype_CONNECTED:
//       Serial.println("Eleven Labs WebSocket connected");
//       elevenLabsConnected = true;
//       break;

//     case WStype_TEXT:
//       // Handle text responses from Eleven Labs (e.g. status messages)
//       Serial.printf("Received text from Eleven Labs: %s\n", payload);
//       break;

//     case WStype_BIN:
//       // Handle binary audio data from Eleven Labs
//       // if (isPlayingTTS) {
//         // Process the audio data and send to audio output
//         // This depends on the format of the audio data returned by Eleven Labs
//         Serial.println("teri ma bkl");
//       // }
//       break;

//     case WStype_ERROR:
//       Serial.println("Eleven Labs WebSocket error");
//       break;
//   }
// }


void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("WebSocket disconnected");
      isConnected = false;
      isRecording = false;
      serverIsSpeaking = false;
      digitalWrite(LED_PIN, LOW);
      break;

    case WStype_CONNECTED:
      Serial.println("WebSocket connected");
      isConnected = true;
      break;

    case WStype_TEXT:
      // Check if the message is JSON
      if (payload[0] == '{') {
        // Parse JSON response
        DynamicJsonDocument doc(4096);  // Adjust size based on your needs
        DeserializationError error = deserializeJson(doc, payload, length);

        if (!error) {
          // Check if it's a command message
          if (doc.containsKey("command")) {
            const char* command = doc["command"];

            if (strcmp(command, "speaking_started") == 0) {
              // Server is now speaking, stop recording
              isRecording = false;
              serverIsSpeaking = true;
              digitalWrite(LED_PIN, LOW);
              Serial.println("Server is speaking, stopped recording");
            } else if (strcmp(command, "speaking_finished") == 0) {
              // Server finished speaking, resume recording
              serverIsSpeaking = false;
              isRecording = true;
              isInterrupting = false;
              digitalWrite(LED_PIN, HIGH);
              Serial.println("Server finished speaking, resumed recording");
            }
          }
          // Process transcript and AI response
          else if (doc.containsKey("transcript")) {
            const char* transcript = doc["transcript"];
            bool isFinal = doc["isFinal"];

            Serial.print("Transcript: ");
            Serial.println(transcript);

            if (isFinal && doc.containsKey("aiResponse")) {
              const char* aiResponse = doc["aiResponse"];
              Serial.println("AI Response: ");

              Serial.println(aiResponse);
              http.begin(client, elevenLabsURL);
              http.addHeader("Content-Type", "application/json");
              http.addHeader("Authorization", "Bearer " + String(apiKey));
              String jsonRequest = String("{\"model\":\"tts-1\",\"input\":\"") + String(aiResponse) + "\",\"voice\":\"alloy\",\"response_format\":\"pcm\"}";
              Serial.println("Request JSON: " + jsonRequest);
              int httpResponseCode = http.POST(jsonRequest);
              if (httpResponseCode > 0) {
                Serial.print("HTTP Response code: ");
                Serial.println(httpResponseCode);

                // The response is an audio file (MP3 or OGG)
                int contentLength = http.getSize();
                Serial.print("Audio File Size: ");
                Serial.println(contentLength);

                
  WiFiClient* stream = http.getStreamPtr();
  Serial.println("Receiving audio data...");
  
  // Read raw PCM data in chunks and write to I2S
  const int bufferSize = 1024;
  uint8_t buffer[bufferSize];
  size_t bytesRead;
  
  while ((bytesRead = stream->read(buffer, bufferSize)) > 0) {
    size_t bytes_written = 0;
    i2s_write(I2S_SPEAKER_PORT, buffer, bytesRead, &bytes_written, portMAX_DELAY);
    
    // Log if we couldn't write all bytes (buffer might be full)
    if (bytes_written < bytesRead) {
      Serial.printf("Partial write: %d/%d bytes\n", bytes_written, bytesRead);
    }
  }
  
  Serial.println("Finished playing audio");
} else {
  Serial.print("HTTP Error: ");
  Serial.println(http.errorToString(httpResponseCode));
}

http.end();
              // generateSpeechFromText(aiResponse);  //using socket
            }
          }
        } else {
          Serial.print("JSON parsing error: ");
          Serial.println(error.c_str());
        }
      } else if (strcmp((char*)payload, "start") == 0) {
        isRecording = true;
        serverIsSpeaking = false;
        digitalWrite(LED_PIN, HIGH);
        Serial.println("Recording started");
      } else if (strcmp((char*)payload, "stop") == 0) {
        isRecording = false;
        digitalWrite(LED_PIN, LOW);
        Serial.println("Recording stopped");
      }
      break;

    case WStype_BIN:
      // Handle binary data if needed
      break;

    case WStype_ERROR:
      Serial.println("WebSocket error");
      digitalWrite(ERROR_LED_PIN, HIGH);
      delay(500);
      digitalWrite(ERROR_LED_PIN, LOW);
      break;

    case WStype_PING:
      // Automatically responds with a pong
      Serial.println("Received ping");
      break;

    case WStype_PONG:
      // Response to our ping
      break;
  }
}

// void generateSpeechFromText(const char* text) {

//   // Prepare the text-to-speech request
//   DynamicJsonDocument doc(1024);
//   doc["text"] = text;
//   doc["voice_settings"]["stability"] = 0.5;
//   doc["voice_settings"]["similarity_boost"] = 0.8;

//   String jsonString;
//   serializeJson(doc, jsonString);

//   // Send the request to Eleven Labs
//   isPlayingTTS = true;
//   elevenLabsWS.sendTXT(jsonString);
// }


// void processElevenLabsAudio(uint8_t* audioData, size_t length) {
//   Serial.println("processAudio Eleven Labs");
// }

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 Voice Assistant with Interruption Support");
  client.setInsecure();
  // Initialize LED pins
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  if (ERROR_LED_PIN != LED_PIN) {
    pinMode(ERROR_LED_PIN, OUTPUT);
    digitalWrite(ERROR_LED_PIN, LOW);
  }

  // Connect to WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected to WiFi, IP address: ");
  Serial.println(WiFi.localIP());

  // Configure WebSocket client
  webSocket.begin(wsHost, wsPort, wsPath);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);

  // audio.setPinout(I2S_SPEAKER_BCLK, I2S_SPEAKER_LRC, I2S_SPEAKER_DOUT);
  // audio.setVolume(200);  // Volume range: 0 - 21

  // String authHeader = "xi-api-key: " + String(elevenLabsAPIKey);
  // elevenLabsWS.begin(elevenLabsWSURL, elevenLabsPort, "/v1/text-to-speech/" + String(voiceID) + "/stream-input?optimize_streaming_latency=4", "wss");
  // elevenLabsWS.onEvent(elevenLabsWSEvent);
  // elevenLabsWS.setExtraHeaders(authHeader.c_str());

  // // Wait for connection (consider implementing a timeout)
  // unsigned long startTime = millis();
  // while (!elevenLabsConnected && millis() - startTime < 5000) {
  //   elevenLabsWS.loop();
  //   delay(10);
  // }


  // Configure I2S for INMP441 microphone
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t i2s_mic_pins = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  // Speaker configuration (I2S1)
i2s_config_t i2s_spk_config = {
  .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
  .sample_rate = 16000,  // Must match the PCM sample rate
  .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,  // PCM data from OpenAI is 16-bit
  .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,  // Stereo
  .communication_format = I2S_COMM_FORMAT_I2S,
  .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
  .dma_buf_count = 8,
  .dma_buf_len = 512,
  .use_apll = false,
  .tx_desc_auto_clear = true,
  .fixed_mclk = 0
};

i2s_pin_config_t i2s_spk_pins = {
    .bck_io_num = I2S_SPEAKER_BCLK,
    .ws_io_num = I2S_SPEAKER_LRC,
    .data_out_num = I2S_SPEAKER_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE
};


  // Install and configure I2S driver
  esp_err_t result = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (result != ESP_OK) {
    Serial.printf("Error installing I2S driver: %d\n", result);
    digitalWrite(ERROR_LED_PIN, HIGH);
    return;
  }

  result = i2s_set_pin(I2S_PORT, &i2s_mic_pins);
  if (result != ESP_OK) {
    Serial.printf("Error setting I2S pins: %d\n", result);
    digitalWrite(ERROR_LED_PIN, HIGH);
    return;
  }

  // Install and configure I2S driver for speaker
  result = i2s_driver_install(I2S_SPK_PORT, &i2s_spk_config, 0, NULL);
  if (result != ESP_OK) {
    Serial.printf("Error installing I2S speaker driver: %d\n", result);
    return;
  }
  
  result = i2s_set_pin(I2S_SPK_PORT, &i2s_spk_pins);
  if (result != ESP_OK) {
    Serial.printf("Error setting I2S speaker pins: %d\n", result);
    return;
  }
  

  Serial.println("I2S configured successfully");
}

void loop() {
  webSocket.loop();

  
  if (isConnected) {
    // Always read audio data for voice activity detection
    int32_t samples[SAMPLE_BUFFER_SIZE];
    int16_t processed_samples[SAMPLE_BUFFER_SIZE];
    size_t bytes_read = 0;

    esp_err_t result = i2s_read(I2S_PORT, samples, sizeof(samples), &bytes_read, 30 / portTICK_PERIOD_MS);

    if (result == ESP_OK && bytes_read > 0) {
      int samples_read = bytes_read / sizeof(int32_t);

      // Convert 32-bit samples to 16-bit and calculate energy
      int32_t energy = 0;
      for (int i = 0; i < samples_read; i++) {
        processed_samples[i] = (samples[i] >> 16) * 2;  // Apply some gain
        energy += abs(processed_samples[i]);
      }
      energy /= samples_read;

      // Check for voice activity to interrupt speaking
      unsigned long currentTime = millis();
      if (serverIsSpeaking && energy > VOICE_THRESHOLD && !isInterrupting && (currentTime - lastInterruptionTime > interruptionCooldown)) {

        Serial.printf("Voice detected (energy: %d) - interrupting\n", energy);
        webSocket.sendTXT("interrupt");
        isInterrupting = true;
        lastInterruptionTime = currentTime;
      }

      // Send audio data only when recording is active
      if (isRecording && !serverIsSpeaking) {
        webSocket.sendBIN((uint8_t*)processed_samples, samples_read * sizeof(int16_t));
      }
    }
  }

  // Check WiFi connection and reconnect if needed
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi connection lost, reconnecting...");
    WiFi.reconnect();
    delay(5000);
  }

  // Small delay to prevent overwhelming the CPU
  delay(10);
}
