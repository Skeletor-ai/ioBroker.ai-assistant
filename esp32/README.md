# ESP32 Voice Client for ioBroker AI Assistant

Push-to-talk voice client that records audio via I2S microphone, sends it to the ioBroker AI Assistant adapter for transcription and LLM processing, and plays back the TTS response through an I2S speaker amplifier.

## Parts List

| Component | Description | ~Price |
|-----------|-------------|--------|
| ESP32 DevKit v1 | ESP32-WROOM-32 development board (with PSRAM recommended) | €5–8 |
| INMP441 | I2S MEMS microphone breakout | €2–4 |
| MAX98357A | I2S Class-D mono amplifier breakout | €2–4 |
| Speaker | 4Ω or 8Ω, 2–3W small speaker | €2–3 |
| Push button | Momentary tactile switch | €0.10 |
| RGB LED | Common cathode (or 3 individual LEDs) | €0.20 |
| 3x 220Ω resistors | For LED current limiting | €0.10 |
| Breadboard + jumper wires | For prototyping | €3–5 |

**Total: ~€15–25**

## Wiring Diagram

```
                         ┌──────────────┐
                         │  ESP32 DevKit │
                         │              │
    ┌─────────┐    3.3V ─┤ 3V3      VIN ├─ 5V ──────┐
    │ INMP441 │     GND ─┤ GND      GND ├─ GND ─┐   │
    │         │          │              │        │   │
    │ VDD ────┤── 3.3V   │              │        │   │
    │ GND ────┤── GND    │              │        │   │
    │ SD  ────┤── GPIO32 │              │        │   │
    │ SCK ────┤── GPIO14 │              │        │   │
    │ WS  ────┤── GPIO15 │              │        │   │
    │ L/R ────┤── GND    │              │        │   │
    └─────────┘          │              │        │   │
                         │              │        │   │
    ┌──────────┐         │              │   ┌────┴───┴──┐
    │ MAX98357 │         │              │   │ MAX98357  │
    │          │         │              │   │           │
    │ DIN  ────┤── GPIO25│              │   │ VIN ── 5V │
    │ BCLK ────┤── GPIO26│              │   │ GND ── GND│
    │ LRC  ────┤── GPIO27│              │   │           │
    │          │         │              │   │ OUT+ ─┐   │
    │          │         │              │   │ OUT- ─┤   │
    └──────────┘         │              │   └───────┤───┘
                         │              │        ┌──┴──┐
    ┌──────────┐         │              │        │ 🔊  │
    │  Button  │         │              │        │Speaker│
    │  ┤├──────┤── GPIO0 │              │        └─────┘
    │  └───────┤── GND   │              │
    └──────────┘         │              │
                         │              │
    ┌──────────┐         │              │
    │ RGB LED  │         │              │
    │ R ─[220Ω]┤── GPIO2 │              │
    │ G ─[220Ω]┤── GPIO4 │              │
    │ B ─[220Ω]┤── GPIO5 │              │
    │ GND ─────┤── GND   │              │
    └──────────┘         └──────────────┘
```

## Arduino IDE Setup

### 1. Install ESP32 Board Support

1. Open Arduino IDE → **File → Preferences**
2. Add to "Additional Board Manager URLs":
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Go to **Tools → Board → Board Manager**
4. Search for "esp32" and install **"esp32 by Espressif Systems"** (≥ 2.0.0)

### 2. Install Required Libraries

Via **Tools → Manage Libraries...**:

- **ArduinoJson** by Benoît Blanchon (≥ 7.0.0)

The following are included with the ESP32 board package (no extra install needed):
- `WiFi.h`
- `HTTPClient.h`
- `driver/i2s.h`
- `base64.h`

### 3. Select Board

- **Tools → Board → ESP32 Arduino → ESP32 Dev Module**
- Flash Size: **4MB**
- Partition Scheme: **Default 4MB with spiffs** (or "Huge APP" if you need more space)
- PSRAM: **Enabled** (if your board has PSRAM — recommended for larger audio buffers)
- Upload Speed: **921600**

## Configuration

Edit the following `#define` values at the top of `esp32-voice-client.ino`:

```cpp
// WiFi credentials
#define WIFI_SSID         "YOUR_WIFI_SSID"
#define WIFI_PASSWORD     "YOUR_WIFI_PASSWORD"

// ioBroker server
#define SERVER_HOST       "192.168.1.100"    // IP of your ioBroker
#define SERVER_PORT       8089               // audioPort in adapter config

// Device ID (shows up in ioBroker logs and states)
#define DEVICE_ID         "esp32-wohnzimmer"
```

### Pin Configuration (optional)

If you need different GPIO pins, modify the pin definitions:

```cpp
// Microphone pins
#define I2S_MIC_SCK       14
#define I2S_MIC_WS        15
#define I2S_MIC_SD        32

// Speaker pins
#define I2S_SPK_BCLK      26
#define I2S_SPK_LRC       27
#define I2S_SPK_DIN       25

// Button & LED
#define BUTTON_PIN        0
#define LED_RED           2
#define LED_GREEN         4
#define LED_BLUE          5
```

## Flashing

1. Connect ESP32 via USB
2. Select the correct port in **Tools → Port**
3. Click **Upload** (→) button
4. If upload fails, hold the **BOOT** button on the ESP32 while clicking Upload, release after "Connecting..." appears
5. Open **Tools → Serial Monitor** (115200 baud) to see debug output

## Usage

1. **Power on** — ESP32 connects to WiFi (blue LED blinks)
2. **Green flash** — Connected successfully
3. **Press and hold button** — Recording starts (red LED)
4. **Release button** — Audio is sent to ioBroker (blue LED = processing)
5. **Green LED** — Playing TTS response (if TTS is enabled in adapter config)
6. **Magenta LED** — Error (check Serial Monitor)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| WiFi won't connect | Check SSID/password, ensure 2.4 GHz network |
| "Failed to allocate audio buffer" | Use ESP32 with PSRAM, or reduce `MAX_RECORD_SEC` |
| No audio recorded | Check INMP441 wiring, ensure L/R pin is connected to GND |
| No sound from speaker | Check MAX98357A wiring, ensure GAIN pin floats or is set |
| HTTP error 404 | Verify SERVER_HOST and SERVER_PORT match your adapter config |
| Timeout errors | Increase `http.setTimeout()`, check ioBroker adapter is running |
| Garbled audio playback | Verify sample rate matches TTS output (check `audioSampleRate` in response) |

## Memory Notes

- Audio buffer: ~320 KB for 10 seconds at 16 kHz/16-bit
- ESP32 with PSRAM: uses `ps_malloc()` (4MB available)
- ESP32 without PSRAM: uses regular heap (~160 KB free after WiFi)
  - Reduce `MAX_RECORD_SEC` to 5 if you encounter issues
- Base64 decoded TTS response also needs temporary memory

## LED Status Reference

| Color | State |
|-------|-------|
| Off | Idle, ready |
| 🔴 Red | Recording |
| 🔵 Blue | Processing (sending/waiting) |
| 🟢 Green | Playing response / success |
| 🟣 Magenta | Error |
| 🔵 Blinking blue | Connecting to WiFi |
