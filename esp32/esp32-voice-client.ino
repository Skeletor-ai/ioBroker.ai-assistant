/**
 * ═══════════════════════════════════════════════════════════════════
 *  ioBroker AI Assistant — ESP32 Voice Client
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Push-to-talk voice client for ESP32 with I2S microphone (INMP441)
 *  and I2S DAC speaker (MAX98357A). Records audio on button press,
 *  sends WAV to ioBroker AI Assistant HTTP endpoint, and plays back
 *  the TTS audio response.
 *
 * ─── WIRING DIAGRAM ─────────────────────────────────────────────
 *
 *  INMP441 Microphone → ESP32
 *  ┌──────────┬────────────┐
 *  │ INMP441  │   ESP32    │
 *  ├──────────┼────────────┤
 *  │ VDD      │   3.3V     │
 *  │ GND      │   GND      │
 *  │ SD       │   GPIO 32  │  (I2S Data In)
 *  │ SCK      │   GPIO 14  │  (I2S Bit Clock)
 *  │ WS       │   GPIO 15  │  (I2S Word Select / LRCK)
 *  │ L/R      │   GND      │  (Left channel — pull to 3.3V for right)
 *  └──────────┴────────────┘
 *
 *  MAX98357A Speaker DAC → ESP32
 *  ┌──────────┬────────────┐
 *  │ MAX98357 │   ESP32    │
 *  ├──────────┼────────────┤
 *  │ VIN      │   5V (USB) │
 *  │ GND      │   GND      │
 *  │ DIN      │   GPIO 25  │  (I2S Data Out)
 *  │ BCLK     │   GPIO 26  │  (I2S Bit Clock)
 *  │ LRC      │   GPIO 27  │  (I2S Word Select / LRCK)
 *  │ GAIN     │   (float)  │  (15dB default; GND=9dB, VIN=12dB)
 *  │ SD       │   (float)  │  (pull LOW to shut down)
 *  └──────────┴────────────┘
 *
 *  Push Button → ESP32
 *  ┌──────────┬────────────┐
 *  │ Button   │   ESP32    │
 *  ├──────────┼────────────┤
 *  │ Pin 1    │   GPIO 0   │  (has internal pull-up)
 *  │ Pin 2    │   GND      │
 *  └──────────┴────────────┘
 *
 *  Status LED (common cathode RGB or NeoPixel)
 *  ┌──────────┬────────────┐
 *  │ LED      │   ESP32    │
 *  ├──────────┼────────────┤
 *  │ Red      │   GPIO 2   │  (via 220Ω resistor)
 *  │ Green    │   GPIO 4   │  (via 220Ω resistor)
 *  │ Blue     │   GPIO 5   │  (via 220Ω resistor)
 *  │ GND      │   GND      │
 *  └──────────┴────────────┘
 *
 * ─── REQUIRED LIBRARIES ─────────────────────────────────────────
 *
 *  - ESP32 Board Package (≥ 2.0.0) — via Arduino Board Manager
 *  - ArduinoJson (≥ 7.0.0) — via Arduino Library Manager
 *  - HTTPClient (built into ESP32 core)
 *  - base64 (built into ESP32 core)
 *
 * ═══════════════════════════════════════════════════════════════════
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include "base64.h"

// ═══════════════════════════════════════════════════════════════════
//  CONFIGURATION — Edit these values for your setup
// ═══════════════════════════════════════════════════════════════════

// WiFi
#define WIFI_SSID         "YOUR_WIFI_SSID"
#define WIFI_PASSWORD     "YOUR_WIFI_PASSWORD"

// ioBroker AI Assistant server
#define SERVER_HOST       "192.168.1.100"    // IP of your ioBroker server
#define SERVER_PORT       8089               // audioPort from adapter config
#define DEVICE_ID         "esp32-wohnzimmer" // Unique device identifier

// I2S Microphone (INMP441) pins
#define I2S_MIC_SCK       14   // Bit clock
#define I2S_MIC_WS        15   // Word select (LRCK)
#define I2S_MIC_SD        32   // Data in

// I2S Speaker DAC (MAX98357A) pins
#define I2S_SPK_BCLK      26   // Bit clock
#define I2S_SPK_LRC       27   // Word select (LRCK)
#define I2S_SPK_DIN       25   // Data out

// Button
#define BUTTON_PIN        0    // GPIO0 (BOOT button on most dev boards)

// Status LED (RGB)
#define LED_RED           2
#define LED_GREEN         4
#define LED_BLUE          5

// Audio parameters
#define SAMPLE_RATE       16000
#define BITS_PER_SAMPLE   16
#define CHANNELS          1
#define MAX_RECORD_SEC    10
#define BUFFER_SIZE       512

// Derived constants
#define MAX_AUDIO_BYTES   (SAMPLE_RATE * (BITS_PER_SAMPLE / 8) * CHANNELS * MAX_RECORD_SEC)
#define WAV_HEADER_SIZE   44

// ═══════════════════════════════════════════════════════════════════
//  GLOBALS
// ═══════════════════════════════════════════════════════════════════

uint8_t* audioBuffer = NULL;
uint32_t audioSize = 0;

enum State {
    STATE_IDLE,
    STATE_RECORDING,
    STATE_PROCESSING,
    STATE_PLAYING,
    STATE_ERROR
};

State currentState = STATE_IDLE;

// ═══════════════════════════════════════════════════════════════════
//  LED CONTROL
// ═══════════════════════════════════════════════════════════════════

void setLed(bool red, bool green, bool blue) {
    digitalWrite(LED_RED,   red   ? HIGH : LOW);
    digitalWrite(LED_GREEN, green ? HIGH : LOW);
    digitalWrite(LED_BLUE,  blue  ? HIGH : LOW);
}

void setStateIdle()       { setLed(false, false, false); currentState = STATE_IDLE; }
void setStateRecording()  { setLed(true,  false, false); currentState = STATE_RECORDING; }   // Red
void setStateProcessing() { setLed(false, false, true);  currentState = STATE_PROCESSING; }  // Blue
void setStatePlaying()    { setLed(false, true,  false); currentState = STATE_PLAYING; }      // Green
void setStateError()      { setLed(true,  false, true);  currentState = STATE_ERROR; }        // Magenta

// ═══════════════════════════════════════════════════════════════════
//  I2S MICROPHONE SETUP
// ═══════════════════════════════════════════════════════════════════

void i2s_mic_init() {
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = BUFFER_SIZE,
        .use_apll = false,
        .tx_desc_auto_clear = false,
        .fixed_mclk = 0
    };

    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_MIC_SCK,
        .ws_io_num = I2S_MIC_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = I2S_MIC_SD
    };

    i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_NUM_0, &pin_config);
    i2s_zero_dma_buffer(I2S_NUM_0);
}

void i2s_mic_deinit() {
    i2s_driver_uninstall(I2S_NUM_0);
}

// ═══════════════════════════════════════════════════════════════════
//  I2S SPEAKER SETUP
// ═══════════════════════════════════════════════════════════════════

void i2s_spk_init(uint32_t sampleRate) {
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = sampleRate,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 1024,
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0
    };

    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_SPK_BCLK,
        .ws_io_num = I2S_SPK_LRC,
        .data_out_num = I2S_SPK_DIN,
        .data_in_num = I2S_PIN_NO_CHANGE
    };

    i2s_driver_install(I2S_NUM_1, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_NUM_1, &pin_config);
    i2s_zero_dma_buffer(I2S_NUM_1);
}

void i2s_spk_deinit() {
    i2s_driver_uninstall(I2S_NUM_1);
}

// ═══════════════════════════════════════════════════════════════════
//  WAV HEADER
// ═══════════════════════════════════════════════════════════════════

void writeWavHeader(uint8_t* buffer, uint32_t dataSize) {
    uint32_t fileSize = dataSize + WAV_HEADER_SIZE - 8;
    uint32_t byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
    uint16_t blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

    // RIFF header
    buffer[0] = 'R'; buffer[1] = 'I'; buffer[2] = 'F'; buffer[3] = 'F';
    buffer[4] = fileSize & 0xFF;
    buffer[5] = (fileSize >> 8) & 0xFF;
    buffer[6] = (fileSize >> 16) & 0xFF;
    buffer[7] = (fileSize >> 24) & 0xFF;
    buffer[8] = 'W'; buffer[9] = 'A'; buffer[10] = 'V'; buffer[11] = 'E';

    // fmt chunk
    buffer[12] = 'f'; buffer[13] = 'm'; buffer[14] = 't'; buffer[15] = ' ';
    buffer[16] = 16; buffer[17] = 0; buffer[18] = 0; buffer[19] = 0; // chunk size
    buffer[20] = 1; buffer[21] = 0; // PCM format
    buffer[22] = CHANNELS; buffer[23] = 0;
    buffer[24] = SAMPLE_RATE & 0xFF;
    buffer[25] = (SAMPLE_RATE >> 8) & 0xFF;
    buffer[26] = (SAMPLE_RATE >> 16) & 0xFF;
    buffer[27] = (SAMPLE_RATE >> 24) & 0xFF;
    buffer[28] = byteRate & 0xFF;
    buffer[29] = (byteRate >> 8) & 0xFF;
    buffer[30] = (byteRate >> 16) & 0xFF;
    buffer[31] = (byteRate >> 24) & 0xFF;
    buffer[32] = blockAlign; buffer[33] = 0;
    buffer[34] = BITS_PER_SAMPLE; buffer[35] = 0;

    // data chunk
    buffer[36] = 'd'; buffer[37] = 'a'; buffer[38] = 't'; buffer[39] = 'a';
    buffer[40] = dataSize & 0xFF;
    buffer[41] = (dataSize >> 8) & 0xFF;
    buffer[42] = (dataSize >> 16) & 0xFF;
    buffer[43] = (dataSize >> 24) & 0xFF;
}

// ═══════════════════════════════════════════════════════════════════
//  RECORDING
// ═══════════════════════════════════════════════════════════════════

bool recordAudio() {
    Serial.println("[REC] Recording started...");
    setStateRecording();

    i2s_mic_init();

    // Leave space for WAV header
    audioSize = WAV_HEADER_SIZE;
    int16_t sampleBuffer[BUFFER_SIZE / 2];
    size_t bytesRead;

    unsigned long startTime = millis();

    while (digitalRead(BUTTON_PIN) == LOW) {
        // Check max duration
        if (millis() - startTime > (MAX_RECORD_SEC * 1000)) {
            Serial.println("[REC] Max duration reached");
            break;
        }

        // Check buffer overflow
        if (audioSize + BUFFER_SIZE >= MAX_AUDIO_BYTES + WAV_HEADER_SIZE) {
            Serial.println("[REC] Buffer full");
            break;
        }

        // Read I2S data
        esp_err_t err = i2s_read(I2S_NUM_0, sampleBuffer, BUFFER_SIZE, &bytesRead, portMAX_DELAY);
        if (err == ESP_OK && bytesRead > 0) {
            memcpy(audioBuffer + audioSize, sampleBuffer, bytesRead);
            audioSize += bytesRead;
        }
    }

    i2s_mic_deinit();

    uint32_t dataSize = audioSize - WAV_HEADER_SIZE;

    if (dataSize < 1600) { // Less than 50ms of audio
        Serial.println("[REC] Too short, ignoring");
        setStateIdle();
        return false;
    }

    // Write WAV header
    writeWavHeader(audioBuffer, dataSize);

    float duration = (float)dataSize / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));
    Serial.printf("[REC] Recorded %.1fs (%u bytes)\n", duration, audioSize);

    return true;
}

// ═══════════════════════════════════════════════════════════════════
//  HTTP UPLOAD & RESPONSE
// ═══════════════════════════════════════════════════════════════════

String sendAudioToServer() {
    Serial.println("[NET] Sending audio to server...");
    setStateProcessing();

    HTTPClient http;
    String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/audio?format=wav";

    http.begin(url);
    http.addHeader("Content-Type", "audio/wav");
    http.addHeader("X-Device-Id", DEVICE_ID);
    http.setTimeout(30000); // 30s timeout for LLM processing

    int httpCode = http.POST(audioBuffer, audioSize);

    if (httpCode != 200) {
        Serial.printf("[NET] HTTP error: %d\n", httpCode);
        http.end();
        return "";
    }

    String response = http.getString();
    http.end();

    Serial.printf("[NET] Response: %d bytes\n", response.length());
    return response;
}

// ═══════════════════════════════════════════════════════════════════
//  AUDIO PLAYBACK
// ═══════════════════════════════════════════════════════════════════

void playAudioBase64(const char* base64Data, uint32_t sampleRate) {
    Serial.println("[PLAY] Decoding audio...");
    setStatePlaying();

    // Decode base64
    String b64Str = String(base64Data);
    int decodedLen = base64_decode_expected_len(b64Str.length());
    uint8_t* decoded = (uint8_t*)malloc(decodedLen + 1);

    if (!decoded) {
        Serial.println("[PLAY] Memory allocation failed");
        setStateError();
        return;
    }

    int actualLen = base64_decode_chars(b64Str.c_str(), b64Str.length(), (char*)decoded);

    if (actualLen <= 0) {
        Serial.println("[PLAY] Base64 decode failed");
        free(decoded);
        setStateError();
        return;
    }

    Serial.printf("[PLAY] Playing %d bytes at %u Hz\n", actualLen, sampleRate);

    // Initialize speaker I2S
    i2s_spk_init(sampleRate);

    // Skip WAV header if present (starts with "RIFF")
    int offset = 0;
    if (actualLen > 44 && decoded[0] == 'R' && decoded[1] == 'I' &&
        decoded[2] == 'F' && decoded[3] == 'F') {
        offset = 44;
    }

    // Write audio data to I2S
    size_t bytesWritten;
    int remaining = actualLen - offset;
    int pos = offset;

    while (remaining > 0) {
        int chunk = remaining > 1024 ? 1024 : remaining;
        i2s_write(I2S_NUM_1, decoded + pos, chunk, &bytesWritten, portMAX_DELAY);
        pos += bytesWritten;
        remaining -= bytesWritten;
    }

    // Flush with silence
    uint8_t silence[1024] = {0};
    i2s_write(I2S_NUM_1, silence, sizeof(silence), &bytesWritten, portMAX_DELAY);

    delay(100);
    i2s_spk_deinit();
    free(decoded);

    Serial.println("[PLAY] Playback complete");
}

// ═══════════════════════════════════════════════════════════════════
//  PROCESS SERVER RESPONSE
// ═══════════════════════════════════════════════════════════════════

void processResponse(const String& response) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, response);

    if (err) {
        Serial.printf("[JSON] Parse error: %s\n", err.c_str());
        setStateError();
        delay(1000);
        setStateIdle();
        return;
    }

    // Print transcription and response text
    if (doc["transcription"].is<const char*>()) {
        Serial.printf("[ASR] \"%s\"\n", doc["transcription"].as<const char*>());
    }
    if (doc["response"].is<const char*>()) {
        Serial.printf("[LLM] \"%s\"\n", doc["response"].as<const char*>());
    }

    // Play TTS audio if available
    if (doc["audioBase64"].is<const char*>()) {
        uint32_t sampleRate = doc["audioSampleRate"] | 22050;
        playAudioBase64(doc["audioBase64"].as<const char*>(), sampleRate);
    } else {
        // Flash green briefly to indicate success without audio
        setStatePlaying();
        delay(500);
    }

    setStateIdle();
}

// ═══════════════════════════════════════════════════════════════════
//  WIFI CONNECTION
// ═══════════════════════════════════════════════════════════════════

void connectWiFi() {
    Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        // Blink blue while connecting
        setLed(false, false, (attempts % 2 == 0));
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
        // Flash green
        setLed(false, true, false);
        delay(500);
        setStateIdle();
    } else {
        Serial.println("\n[WiFi] Connection FAILED!");
        setStateError();
        delay(3000);
        ESP.restart();
    }
}

// ═══════════════════════════════════════════════════════════════════
//  SETUP & LOOP
// ═══════════════════════════════════════════════════════════════════

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println();
    Serial.println("═══════════════════════════════════════════");
    Serial.println("  ioBroker AI Assistant — ESP32 Client");
    Serial.println("═══════════════════════════════════════════");

    // LED pins
    pinMode(LED_RED, OUTPUT);
    pinMode(LED_GREEN, OUTPUT);
    pinMode(LED_BLUE, OUTPUT);
    setStateIdle();

    // Button pin with internal pull-up
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // Allocate audio buffer (WAV header + max audio)
    audioBuffer = (uint8_t*)ps_malloc(MAX_AUDIO_BYTES + WAV_HEADER_SIZE);
    if (!audioBuffer) {
        // Fall back to regular malloc if no PSRAM
        audioBuffer = (uint8_t*)malloc(MAX_AUDIO_BYTES + WAV_HEADER_SIZE);
    }

    if (!audioBuffer) {
        Serial.println("[ERR] Failed to allocate audio buffer!");
        Serial.printf("[ERR] Needed %d bytes, free heap: %d\n",
                      MAX_AUDIO_BYTES + WAV_HEADER_SIZE, ESP.getFreeHeap());
        setStateError();
        while (true) delay(1000);
    }

    Serial.printf("[MEM] Audio buffer: %d bytes allocated (free: %d)\n",
                  MAX_AUDIO_BYTES + WAV_HEADER_SIZE, ESP.getFreeHeap());

    // Connect to WiFi
    connectWiFi();

    Serial.println("[OK] Ready! Press button to speak.");
}

void loop() {
    // Reconnect WiFi if lost
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WiFi] Reconnecting...");
        connectWiFi();
    }

    // Check button press (active LOW)
    if (digitalRead(BUTTON_PIN) == LOW) {
        delay(50); // Debounce
        if (digitalRead(BUTTON_PIN) == LOW) {

            // Record audio while button is held
            if (recordAudio()) {
                // Send to server
                String response = sendAudioToServer();

                if (response.length() > 0) {
                    processResponse(response);
                } else {
                    Serial.println("[ERR] Empty or failed response");
                    setStateError();
                    delay(1000);
                    setStateIdle();
                }
            }

            // Wait for button release
            while (digitalRead(BUTTON_PIN) == LOW) {
                delay(10);
            }
            delay(50); // Debounce release
        }
    }

    delay(10); // Prevent watchdog triggers
}
