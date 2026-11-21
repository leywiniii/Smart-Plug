#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include <EEPROM.h>

// ======================================
// SETTINGS  (EDIT THESE)
// ======================================

// Your Cloudflare domain (goes to localhost:8080 via tunnel)
const char* SERVER_URL = "https://mysmartplug.online/api/readings";

// Must match API_KEY in server.py
const char* API_KEY = "psu-smartplug-2026";

// WiFi setup mode (phone connects to the ESP32 to choose a new WiFi)
#define AP_SSID "MySmartPlug-Setup"
#define AP_PASS "smartplug123"       // min 8 characters

// Button: one leg to GPIO 27, other leg to GND
#define BTN_PIN 27 


// If the saved WiFi cannot be joined after this time (e.g. device moved
// to a new place), the setup mode opens by itself.
const bool          AUTO_SETUP_IF_NO_WIFI = true;
const unsigned long STA_CONNECT_TIMEOUT_MS = 45000;

const unsigned long READ_INTERVAL_MS = 2000;

// ======================================
// SENSOR MODE
// true  = real sensor reading
// false = simulated value (220 V / 1.5 A)
// ======================================

const bool USE_REAL_VOLTAGE = true;
const bool USE_REAL_CURRENT = true;

// ======================================
// SENSOR HARDWARE SETTINGS
// ======================================

// ACS712-05B -> 185.0 | ACS712-20A -> 100.0 | ACS712-30A -> 66.0  (mV/A)
const float ACS_SENSITIVITY_MV_PER_A = 100.0f;

// Voltage divider on the ACS712 output (10k top, 20k bottom) = 0.6667
const float ACS_ADC_SCALE = 0.6667f;

const float CURRENT_NOISE_FLOOR_A = 0.08f;
const float VOLTAGE_MIN_VALID_V   = 30.0f;

// 100 ms = 6 full cycles at 60 Hz
const unsigned long SAMPLE_WINDOW_US = 100000UL;

// ======================================
// CALIBRATION  (SET THESE IN THE CODE)
// ======================================

// Voltage: volts per mV(rms) of the ZMPT101B signal.
// Calibrate: plug mains in, type "cv <real volts>" in the Serial Monitor,
// then copy the number it prints into the line below and re-upload.
const float VOLTAGE_CAL_DEFAULT = 0.2404f;

// Current: multiplier on top of the ACS712 formula (1.0 = no correction).
// Calibrate with "ci <real amps>" the same way.
const float CURRENT_CAL_DEFAULT = 1.0f;

// false = always use the numbers written above in the code (recommended)
// true  = values typed with cv / ci are saved in memory and override the code
const bool USE_SAVED_CALIBRATION = false;

// No AC connected = the ZMPT101B signal is only a few mV of noise.
// Below this raw level the voltage is shown as 0 V, whatever the calibration.
const float VOLTAGE_NO_SIGNAL_MV = 60.0f;

// "cv" refuses to calibrate unless the raw signal is at least this strong
const float MIN_CAL_RAW_MV = 100.0f;

// ======================================
// PINS
// ======================================

#define DS18B20_PIN 4
#define ACS712_PIN 34
#define ZMPT101B_PIN 35

OneWire oneWire(DS18B20_PIN);
DallasTemperature temperatureSensor(&oneWire);

WebServer server(80);
Preferences prefs;   // sensor calibration

// ======================================
// WIFI SETTINGS SAVED IN EEPROM
// ======================================

#define MAGIC 0xC0FFEE03

struct Config {
  uint32_t magic;
  char ssid[33];
  char pass[65];
  uint16_t interval;   // upload interval in seconds
};

Config cfg;

volatile bool btnPressed = false;
bool inAP = false;
bool everConnected = false;
unsigned long staStartMs = 0;

// ======================================
// CALIBRATION (saved in ESP32 memory)
// ======================================

float voltageCal = VOLTAGE_CAL_DEFAULT;
float currentCal = CURRENT_CAL_DEFAULT;

float lastVoltageRawMv = 0.0f;
float lastCurrentRawA  = 0.0f;

// ======================================
// SENSOR DATA
// ======================================

float voltage = 0.0;
float current = 0.0;
float power = 0.0;

float temperature = 0.0;
bool temperatureValid = false;

// ======================================
// BUTTON INTERRUPT (simple debounce)
// ======================================

void IRAM_ATTR onButton() {
  static unsigned long lastPress = 0;

  if (millis() - lastPress > 500) {
    btnPressed = true;
    lastPress = millis();
  }
}

// ======================================
// EEPROM
// ======================================

void loadConfig() {
  EEPROM.begin(sizeof(Config));
  EEPROM.get(0, cfg);

  if (cfg.magic != MAGIC) {
    // blank or first use: defaults
    memset(&cfg, 0, sizeof(cfg));
    cfg.magic = MAGIC;
    cfg.interval = 3;
  }

  if (cfg.interval < 1) cfg.interval = 3;
}

void saveConfig() {
  EEPROM.put(0, cfg);
  EEPROM.commit();   // actually writes to flash
}

// ======================================
// ADC RMS MEASUREMENT
// ======================================

// Measures the AC part of a signal (DC offset removed).
// rmsMv  = RMS of the AC part in mV
// meanMv = DC offset in mV
void measureRms(int pin, float &rmsMv, float &meanMv) {
  double sum = 0.0;
  double sumSq = 0.0;
  uint32_t n = 0;

  unsigned long startUs = micros();
  while (micros() - startUs < SAMPLE_WINDOW_US) {
    float mv = (float)analogReadMilliVolts(pin);
    sum += mv;
    sumSq += (double)mv * mv;
    n++;
  }

  rmsMv = 0.0f;
  meanMv = 0.0f;
  if (n == 0) return;

  double mean = sum / n;
  double variance = (sumSq / n) - (mean * mean);
  if (variance < 0.0) variance = 0.0;

  meanMv = (float)mean;
  rmsMv = (float)sqrt(variance);
}

// ======================================
// SENSORS
// ======================================

void readTemperature() {
  temperatureSensor.requestTemperatures();
  float reading = temperatureSensor.getTempCByIndex(0);

  if (reading == DEVICE_DISCONNECTED_C) {
    temperatureValid = false;
    return;
  }

  temperature = reading;
  temperatureValid = true;
}

void readVoltage() {
  if (!USE_REAL_VOLTAGE) {
    voltage = 220.0f;
    return;
  }

  float rmsMv, meanMv;
  measureRms(ZMPT101B_PIN, rmsMv, meanMv);
  lastVoltageRawMv = rmsMv;

  // No AC connected (only noise) -> 0 V, regardless of calibration
  if (rmsMv < VOLTAGE_NO_SIGNAL_MV) {
    voltage = 0.0f;
    return;
  }

  voltage = rmsMv * voltageCal;
  if (voltage < VOLTAGE_MIN_VALID_V) voltage = 0.0f;
}

void readCurrent() {
  if (!USE_REAL_CURRENT) {
    current = 1.5f;
    return;
  }

  float rmsMv, meanMv;
  measureRms(ACS712_PIN, rmsMv, meanMv);

  float sensorMv = rmsMv / ACS_ADC_SCALE;
  lastCurrentRawA = sensorMv / ACS_SENSITIVITY_MV_PER_A;

  current = lastCurrentRawA * currentCal;
  if (current < CURRENT_NOISE_FLOOR_A) current = 0.0f;
}

void updateReadings() {
  readTemperature();
  readVoltage();
  readCurrent();

  // Apparent power (V x I)
  power = voltage * current;
}

// ======================================
// BUILD JSON (local API + upload)
// ======================================

String buildJson() {
  String json = "{";
  json += "\"voltage\":" + String(voltage, 2) + ",";
  json += "\"current\":" + String(current, 3) + ",";
  json += "\"temperature\":";
  json += temperatureValid ? String(temperature, 2) : "null";
  json += ",\"temperature_valid\":";
  json += temperatureValid ? "true" : "false";
  json += ",\"power\":" + String(power, 2);
  json += ",\"voltage_source\":\"";
  json += USE_REAL_VOLTAGE ? "measured" : "simulated";
  json += "\",\"current_source\":\"";
  json += USE_REAL_CURRENT ? "measured" : "simulated";
  json += "\"}";
  return json;
}

// ======================================
// WIFI MODES
// ======================================

void startSTA() {
  inAP = false;
  everConnected = false;
  staStartMs = millis();

  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  if (strlen(cfg.ssid) > 0) {
    WiFi.begin(cfg.ssid, cfg.pass);
    Serial.print("STA mode: connecting to ");
    Serial.println(cfg.ssid);
  } else {
    Serial.println("STA mode: no WiFi saved, press the button for setup");
  }
}

void startAP() {
  inAP = true;

  WiFi.disconnect();
  WiFi.mode(WIFI_AP_STA);   // AP + idle station, so WiFi scanning works
  WiFi.softAP(AP_SSID, AP_PASS);

  Serial.println();
  Serial.println("SETUP MODE");
  Serial.print("1) On your phone, join WiFi: ");
  Serial.println(AP_SSID);
  Serial.print("2) Open http://");
  Serial.println(WiFi.softAPIP());   // 192.168.4.1
}

// ======================================
// WEB PAGES
// ======================================

String htmlEscape(const String& s) {
  String o;
  o.reserve(s.length() + 8);

  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    switch (c) {
      case '&':  o += "&amp;";  break;
      case '<':  o += "&lt;";   break;
      case '>':  o += "&gt;";   break;
      case '"':  o += "&quot;"; break;
      case '\'': o += "&#39;";  break;
      default:   o += c;
    }
  }
  return o;
}

String urlEncode(const String& s) {
  String o;
  char buf[4];

  for (size_t i = 0; i < s.length(); i++) {
    unsigned char c = (unsigned char)s[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      o += (char)c;
    } else {
      snprintf(buf, sizeof(buf), "%%%02X", c);
      o += buf;
    }
  }
  return o;
}

String pageStart(const String& title) {
  String h = "<!DOCTYPE html><html><head><meta charset='utf-8'>"
             "<meta name='viewport' content='width=device-width, initial-scale=1'>"
             "<title>";
  h += title;
  h += "</title><style>"
       "body{font-family:sans-serif;max-width:420px;margin:20px auto;padding:0 14px}"
       "input[type=text],input[type=password],input[type=number]"
       "{width:100%;padding:10px;font-size:16px;box-sizing:border-box}"
       "button{padding:12px 18px;font-size:16px;margin-top:6px}"
       "</style></head><body><h2>";
  h += title;
  h += "</h2>";
  return h;
}

void handleRoot() {
  String h;

  if (inAP) {
    String shownSsid = server.hasArg("ssid") ? server.arg("ssid") : String(cfg.ssid);

    h = pageStart("WiFi Setup");
    h += "<p><a href='/scan'>Scan nearby WiFi networks</a></p>";
    h += "<form action='/save' method='POST'>";
    h += "WiFi name (SSID)<br><input type='text' name='ssid' value='" + htmlEscape(shownSsid) + "'><br><br>";
    h += "WiFi password<br><input type='password' name='pass' id='pw' placeholder='leave blank to keep current'><br>";
    h += "<label><input type='checkbox' onclick=\"document.getElementById('pw').type=this.checked?'text':'password'\"> Show password</label><br><br>";
    h += "Upload interval (seconds)<br><input type='number' name='interval' min='1' max='3600' value='" + String(cfg.interval) + "'><br><br>";
    h += "<button type='submit'>Save &amp; Restart</button>";
    h += "</form>";

  } else {
    h = pageStart("MySmartPlug Status");
    h += "Mode: STA (normal)<br>";
    h += "WiFi: " + htmlEscape(String(cfg.ssid)) + "<br>";
    h += "IP: " + WiFi.localIP().toString() + "<br>";
    h += "Signal: " + String(WiFi.RSSI()) + " dBm<br>";
    h += "Upload interval: " + String(cfg.interval) + " s<br><br>";
    h += "<a href='/api/readings'>Live readings (JSON)</a><br><br>";
    h += "Press the button on the device to open setup mode.";
  }

  h += "</body></html>";
  server.send(200, "text/html", h);
}

void handleScan() {
  if (!inAP) {
    server.sendHeader("Location", "/");
    server.send(302, "text/plain", "");
    return;
  }

  int n = WiFi.scanNetworks();

  String h = pageStart("Nearby WiFi");

  if (n <= 0) {
    h += "No networks found. <a href='/scan'>Scan again</a><br>";
  } else {
    h += "Tap a network to select it:<br><br>";
    for (int i = 0; i < n; i++) {
      String s = WiFi.SSID(i);
      if (s.length() == 0) continue;
      h += "<p><a href='/?ssid=" + urlEncode(s) + "'>" + htmlEscape(s) + "</a> (" + String(WiFi.RSSI(i)) + " dBm)</p>";
    }
  }

  WiFi.scanDelete();

  h += "<br><a href='/'>Back</a></body></html>";
  server.send(200, "text/html", h);
}

void handleSave() {
  if (!inAP) {
    server.send(403, "text/plain", "Setup is only available in setup mode");
    return;
  }

  String ssid = server.arg("ssid");
  ssid.trim();

  String pass = server.arg("pass");

  if (ssid.length() == 0) {
    server.send(200, "text/html",
                pageStart("Error") +
                "SSID cannot be empty. <a href='/'>Back</a></body></html>");
    return;
  }

  if (pass.length() > 0 && (pass.length() < 8 || pass.length() > 63)) {
    server.send(200, "text/html",
                pageStart("Error") +
                "WiFi password must be 8 to 63 characters. <a href='/'>Back</a></body></html>");
    return;
  }

  bool ssidChanged = (ssid != String(cfg.ssid));

  strlcpy(cfg.ssid, ssid.c_str(), sizeof(cfg.ssid));

  if (pass.length() > 0) {
    strlcpy(cfg.pass, pass.c_str(), sizeof(cfg.pass));
  } else if (ssidChanged) {
    cfg.pass[0] = '\0';   // new network and no password typed = open network
  }

  long iv = server.arg("interval").toInt();
  if (iv < 1) iv = 1;
  if (iv > 3600) iv = 3600;
  cfg.interval = (uint16_t)iv;

  saveConfig();

  server.send(200, "text/html",
              pageStart("Saved") +
              "Settings saved. The device will restart and join <b>" + htmlEscape(ssid) +
              "</b>.<br>You can now reconnect your phone to your normal WiFi."
              "</body></html>");

  delay(2000);   // give the page time to reach the phone
  ESP.restart();
}

void handleReadings() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", buildJson());
}

void handleNotFound() {
  server.sendHeader("Location", "/");
  server.send(302, "text/plain", "");
}

// ======================================
// SEND TO WEBSITE
// ======================================

void sendToServer() {
  if (inAP || WiFi.status() != WL_CONNECTED) {
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();  // skips certificate check (fine for school project)

  HTTPClient http;
  http.setTimeout(5000);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("HTTP begin failed");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);

  int code = http.POST(buildJson());

  if (code > 0) {
    Serial.print("Upload OK, HTTP ");
    Serial.println(code);
  } else {
    Serial.print("Upload failed: ");
    Serial.println(http.errorToString(code));
  }

  http.end();
}

// ======================================
// SERIAL COMMANDS
// Serial Monitor: 115200 baud, line ending = "Newline"
//
//   cv 221.5   -> calibrate voltage to the real value (multimeter)
//   ci 0.45    -> calibrate current to the real value (known load)
//   show       -> print calibration + saved WiFi name
//   reset      -> calibration back to defaults
//   clearwifi  -> forget the saved WiFi and restart
// ======================================

void printCalibration() {
  Serial.printf("Calibration -> voltageCal: %.5f V/mV, currentCal: %.4f\n",
                voltageCal, currentCal);
}

void handleSerialCommands() {
  if (!Serial.available()) return;

  String line = Serial.readStringUntil('\n');
  line.trim();
  line.toLowerCase();
  if (line.length() == 0) return;

  if (line.startsWith("cv ")) {
    float reference = line.substring(3).toFloat();
    if (reference > 0 && lastVoltageRawMv >= MIN_CAL_RAW_MV) {
      voltageCal = reference / lastVoltageRawMv;
      if (USE_SAVED_CALIBRATION) prefs.putFloat("vcal", voltageCal);
      Serial.println("Voltage calibrated.");
      printCalibration();
      Serial.printf("Put this in the code: const float VOLTAGE_CAL_DEFAULT = %.5ff;\n", voltageCal);
    } else {
      Serial.printf("Cannot calibrate voltage: raw signal is only %.1f mV (need at least %.0f mV). "
                    "Is mains connected to the ZMPT101B? Use: cv 220 (with a space)\n",
                    lastVoltageRawMv, MIN_CAL_RAW_MV);
    }

  } else if (line.startsWith("ci ")) {
    float reference = line.substring(3).toFloat();
    if (reference > 0 && lastCurrentRawA > CURRENT_NOISE_FLOOR_A) {
      currentCal = reference / lastCurrentRawA;
      if (USE_SAVED_CALIBRATION) prefs.putFloat("ical", currentCal);
      Serial.println("Current calibrated.");
      printCalibration();
      Serial.printf("Put this in the code: const float CURRENT_CAL_DEFAULT = %.5ff;\n", currentCal);
    } else {
      Serial.println("Cannot calibrate current: no load detected. Plug in a known load first.");
    }

  } else if (line == "show") {
    printCalibration();
    Serial.print("Saved WiFi: ");
    Serial.println(strlen(cfg.ssid) > 0 ? cfg.ssid : "(none)");

  } else if (line == "reset") {
    voltageCal = VOLTAGE_CAL_DEFAULT;
    currentCal = CURRENT_CAL_DEFAULT;
    prefs.remove("vcal");
    prefs.remove("ical");
    Serial.println("Calibration reset to the values written in the code.");
    printCalibration();

  } else if (line == "clearwifi") {
    cfg.ssid[0] = '\0';
    cfg.pass[0] = '\0';
    saveConfig();
    Serial.println("Saved WiFi cleared. Restarting...");
    delay(500);
    ESP.restart();

  } else {
    Serial.println("Commands: cv <volts>, ci <amps>, show, reset, clearwifi");
  }
}

// ======================================
// SETUP
// ======================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("MY SMART PLUG STARTING");

  WiFi.persistent(false);   // only our EEPROM stores WiFi credentials

  pinMode(BTN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BTN_PIN), onButton, FALLING);

  // ADC: 12-bit, full 0-3.3 V range
  analogReadResolution(12);
  analogSetPinAttenuation(ACS712_PIN, ADC_11db);
  analogSetPinAttenuation(ZMPT101B_PIN, ADC_11db);

  // Sensor calibration
  prefs.begin("smartplug", false);
  if (USE_SAVED_CALIBRATION) {
    voltageCal = prefs.getFloat("vcal", VOLTAGE_CAL_DEFAULT);
    currentCal = prefs.getFloat("ical", CURRENT_CAL_DEFAULT);
  } else {
    // wipe any old saved value so it can never come back by mistake
    prefs.remove("vcal");
    prefs.remove("ical");
  }
  printCalibration();

  temperatureSensor.begin();
  Serial.print("DS18B20 devices found: ");
  Serial.println(temperatureSensor.getDeviceCount());

  // WiFi settings
  loadConfig();

  if (strlen(cfg.ssid) == 0) {
    Serial.println("No WiFi saved yet, starting setup mode.");
    startAP();
  } else {
    startSTA();
  }

  server.on("/", handleRoot);
  server.on("/scan", handleScan);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/api/readings", HTTP_GET, handleReadings);
  server.onNotFound(handleNotFound);

  server.begin();
}

// ======================================
// LOOP
// ======================================

unsigned long previousRead = 0;
unsigned long previousSend = 0;
unsigned long previousReconnect = 0;

void loop() {
  server.handleClient();
  handleSerialCommands();

  unsigned long now = millis();

  // Button press: toggle between normal mode and setup mode
  if (btnPressed) {
    btnPressed = false;

    if (inAP) {
      if (strlen(cfg.ssid) > 0) {
        startSTA();
      } else {
        Serial.println("No WiFi saved yet, staying in setup mode.");
      }
    } else {
      startAP();
    }
  }

  // Normal mode: keep WiFi connected
  if (!inAP) {
    if (WiFi.status() == WL_CONNECTED) {
      if (!everConnected) {
        everConnected = true;
        Serial.print("Connected, IP: ");
        Serial.println(WiFi.localIP());
      }
    } else if (strlen(cfg.ssid) > 0) {
      if (now - previousReconnect >= 15000) {
        previousReconnect = now;
        Serial.println("Reconnecting WiFi...");
        WiFi.disconnect();
        WiFi.begin(cfg.ssid, cfg.pass);
      }

      // Never connected since start (moved to a new place?) -> open setup
      if (AUTO_SETUP_IF_NO_WIFI && !everConnected &&
          now - staStartMs > STA_CONNECT_TIMEOUT_MS) {
        Serial.println("Cannot join the saved WiFi. Opening setup mode.");
        startAP();
      }
    }
  }

  // Read sensors
  if (now - previousRead >= READ_INTERVAL_MS) {
    previousRead = now;
    updateReadings();

    Serial.println();
    Serial.println("===== MY SMART PLUG =====");
    Serial.printf("Mode: %s\n", inAP ? "SETUP (AP)" : "NORMAL (STA)");
    Serial.printf("Voltage: %.1f V (%s)", voltage, USE_REAL_VOLTAGE ? "MEASURED" : "SIMULATED");
    if (USE_REAL_VOLTAGE) Serial.printf("  [raw %.1f mV rms]", lastVoltageRawMv);
    Serial.println();

    Serial.printf("Current: %.3f A (%s)", current, USE_REAL_CURRENT ? "MEASURED" : "SIMULATED");
    if (USE_REAL_CURRENT) Serial.printf("  [raw %.3f A]", lastCurrentRawA);
    Serial.println();

    if (temperatureValid) {
      Serial.printf("Temperature: %.2f C (ACTUAL)\n", temperature);
    } else {
      Serial.println("Temperature: Unavailable");
    }
    Serial.printf("Power: %.1f W (apparent)\n", power);
  }

  // Push to website (normal mode only)
  if (now - previousSend >= (unsigned long)cfg.interval * 1000UL) {
    previousSend = now;
    sendToServer();
  }
}