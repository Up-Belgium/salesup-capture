// ============================================================================
// salesUp Capture — hardware-prototype (Seeed XIAO ESP32S3 Sense)
// ============================================================================
// Plaud-principe: knop indrukken = opnemen (16 kHz mono WAV naar microSD),
// nog eens drukken = stoppen. Zodra WiFi beschikbaar is worden afgewerkte
// opnames geüpload naar de salesUp Capture ingest (X-Device-Token) en daarna
// lokaal verwijderd. LED aan = opname loopt; knipperen = upload bezig.
//
// Benodigde libraries (Arduino IDE):
//   - espressif/arduino-esp32 >= 3.0 (board: XIAO_ESP32S3)
//   - ArduinoJson
//
// PROTOTYPE-NOTITIES
//   - TLS: WiFiClientSecure met setInsecure() — goed genoeg om het concept te
//     bewijzen, vóór klantgebruik pinnen we het Supabase-certificaat.
//   - De knopdruk is bewust de consent-handeling (consent_method
//     'device_button'); informeer je gesprekspartner — het device doet dat
//     niet voor jou.
// ============================================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP_I2S.h>
#include <SD.h>
#include "secrets.h"

// XIAO ESP32S3 Sense
#define PIN_BUTTON   1     // drukknop naar GND (INPUT_PULLUP)
#define PIN_LED      LED_BUILTIN
#define PDM_CLK      42
#define PDM_DATA     41
#define SD_CS        21

#define SAMPLE_RATE  16000
#define UPLOAD_DIR   "/rec"

I2SClass i2s;
bool recording = false;
File wavFile;
uint32_t dataBytes = 0;
uint32_t recStartedMs = 0;

// ── WAV-header (16-bit mono PCM) ────────────────────────────────────────────
void writeWavHeader(File &f, uint32_t dataLen) {
  uint32_t fileLen = dataLen + 36;
  uint32_t byteRate = SAMPLE_RATE * 2;
  uint8_t h[44] = {
    'R','I','F','F', 0,0,0,0, 'W','A','V','E','f','m','t',' ',
    16,0,0,0, 1,0, 1,0, 0,0,0,0, 0,0,0,0, 2,0, 16,0, 'd','a','t','a', 0,0,0,0 };
  memcpy(h + 4,  &fileLen, 4);
  memcpy(h + 24, (uint32_t[]){SAMPLE_RATE}, 4);
  memcpy(h + 28, &byteRate, 4);
  memcpy(h + 40, &dataLen, 4);
  f.seek(0);
  f.write(h, 44);
}

void startRecording() {
  char name[40];
  snprintf(name, sizeof(name), UPLOAD_DIR "/cap-%lu.wav", (unsigned long)millis());
  wavFile = SD.open(name, FILE_WRITE);
  if (!wavFile) return;
  uint8_t empty[44] = {0};
  wavFile.write(empty, 44);          // placeholder-header
  dataBytes = 0;
  recStartedMs = millis();
  recording = true;
  digitalWrite(PIN_LED, HIGH);
}

void stopRecording() {
  recording = false;
  writeWavHeader(wavFile, dataBytes);
  wavFile.close();
  digitalWrite(PIN_LED, LOW);
}

// ── Upload-flow: start → PUT → complete ─────────────────────────────────────
bool uploadFile(const String &path) {
  File f = SD.open(path, FILE_READ);
  if (!f) return false;
  size_t size = f.size();
  uint32_t durationS = (size > 44) ? ((size - 44) / 2 / SAMPLE_RATE) : 0;

  WiFiClientSecure tls;
  tls.setInsecure();                 // prototype — zie notitie bovenaan
  HTTPClient http;

  // 1 · start
  http.begin(tls, INGEST_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  JsonDocument req;
  req["action"] = "start";
  req["recording_type"] = "in_person";
  req["started_at"] = "1970-01-01T00:00:00Z";  // device heeft geen klok; server-tijd volgt via complete
  req["ext"] = "wav";
  req["title"] = path.substring(path.lastIndexOf('/') + 1);
  String body;
  serializeJson(req, body);
  int code = http.POST(body);
  if (code != 200) { http.end(); f.close(); return false; }
  JsonDocument res;
  deserializeJson(res, http.getString());
  String uploadUrl = res["upload_url"].as<String>();
  String recordingId = res["recording_id"].as<String>();
  http.end();
  if (uploadUrl.isEmpty()) { f.close(); return false; }

  // 2 · PUT van de WAV (gestreamd vanaf SD)
  HTTPClient put;
  put.begin(tls, uploadUrl);
  put.addHeader("Content-Type", "audio/wav");
  put.addHeader("x-upsert", "false");
  int putCode = put.sendRequest("PUT", &f, size);
  put.end();
  f.close();
  if (putCode < 200 || putCode >= 300) return false;

  // 3 · complete (+ consent: de knopdruk)
  HTTPClient done;
  done.begin(tls, INGEST_URL);
  done.addHeader("Content-Type", "application/json");
  done.addHeader("X-Device-Token", DEVICE_TOKEN);
  JsonDocument c;
  c["action"] = "complete";
  c["recording_id"] = recordingId;
  c["duration_seconds"] = durationS;
  c["consent_status"] = "informed";
  c["consent_method"] = "device_button";
  c["consent_details"] = "Opname bewust gestart met de knop op het device.";
  String cb;
  serializeJson(c, cb);
  int dc = done.POST(cb);
  done.end();
  return dc == 200;
}

void uploadPending() {
  if (WiFi.status() != WL_CONNECTED) return;
  File dir = SD.open(UPLOAD_DIR);
  if (!dir) return;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    String path = String(UPLOAD_DIR) + "/" + f.name();
    f.close();
    digitalWrite(PIN_LED, HIGH); delay(60); digitalWrite(PIN_LED, LOW);
    if (uploadFile(path)) SD.remove(path);
  }
  dir.close();
}

// ── Setup / loop ─────────────────────────────────────────────────────────────
void setup() {
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  i2s.setPinsPdmRx(PDM_CLK, PDM_DATA);
  i2s.begin(I2S_MODE_PDM_RX, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);

  SD.begin(SD_CS);
  if (!SD.exists(UPLOAD_DIR)) SD.mkdir(UPLOAD_DIR);

  WiFi.begin(WIFI_SSID, WIFI_PASS);   // verbindt op de achtergrond
}

void loop() {
  // knop met debounce: toggle opname
  static uint32_t lastPress = 0;
  if (digitalRead(PIN_BUTTON) == LOW && millis() - lastPress > 400) {
    lastPress = millis();
    if (recording) stopRecording();
    else startRecording();
  }

  if (recording) {
    // audio doorpompen naar SD
    static int16_t buf[512];
    size_t n = i2s.readBytes((char *)buf, sizeof(buf));
    if (n > 0) {
      wavFile.write((uint8_t *)buf, n);
      dataBytes += n;
      if (dataBytes % 65536 < sizeof(buf)) wavFile.flush();
    }
  } else {
    // idle: elke 30 s kijken of er iets te uploaden valt
    static uint32_t lastUpload = 0;
    if (millis() - lastUpload > 30000) {
      lastUpload = millis();
      uploadPending();
    }
  }
}
