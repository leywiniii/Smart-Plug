# Smart-Plug
# MySmartPlug

### Smart Electrical Safety & Control System
MySmartPlug is an IoT based smart plug system designed to provide users with a simple way to monitor, control, and protect connected electrical appliances. The system monitors important electrical conditions such as voltage, current, and temperature and can automatically disconnect the connected appliance when an unsafe condition is detected.

The website serves as the main interface for presenting the MySmartPlug system, its features, monitoring capabilities, safety mechanism, and overall project concept.

---

## Features

### Electrical Monitoring
MySmartPlug is designed to monitor:

* Voltage
* Current
* Temperature
* Appliance operating status

These measurements help users understand the condition and activity of their connected appliance.

### Automatic Protection
The system is designed to continuously evaluate sensor readings against defined safety conditions. When an unsafe condition is detected, the connected appliance can be automatically disconnected.

### Remote Control
The web interface is designed to allow users to view the system status and control the connected outlet remotely.

### Safety Notifications
MySmartPlug provides visual and audible warnings when an abnormal or unsafe condition is detected.

### Local Protection
The core safety logic is intended to operate locally on the device, allowing the protection mechanism to remain active even when the network connection is unavailable.

---

## How It Works
The MySmartPlug system follows four main stages:

### 1. Sense
Sensors collect information from the connected appliance, including voltage, current, and temperature.

### 2. Process
The microcontroller processes the sensor readings and checks them against defined safety thresholds.

### 3. Protect
If an unsafe condition is detected, the system automatically disconnects the connected appliance.

### 4. Notify
The system provides visual and audible warnings and updates the status displayed on the web interface.

---

## Website
The website provides an elegant and responsive interface for presenting the MySmartPlug system.

Main sections include:

* Home
* About MySmartPlug
* Monitoring & Protection
* How It Works
* Frequently Asked Questions

The website also includes a product showcase using the MySmartPlug product images and interactive navigation.

---

## Project Structure
A typical project structure is:

```text
MySmartPlug/
│
├── index.html
├── mysmartplug.css
├── mysmartplug.js
│
├── black.png
├── white.png
│
├── images/
│   └── mysmartplug-product.png
│
└── README.md
```

Depending on the current version of the website, some CSS and JavaScript may be included directly inside the HTML file instead of being stored in separate files.

---

## Technologies Used
The website uses standard web technologies:

* HTML5
* CSS
* JavaScript
* Responsive Web Design

The current website also uses JavaScript functionality for interactions such as navigation behavior and section tracking.

---

## Product Concept
MySmartPlug is intended to act as an additional layer of monitoring and protection for existing household appliances.

Instead of replacing an appliance, the smart plug is placed between the power source and the appliance, allowing the system to monitor electrical conditions and respond to potentially unsafe situations.

The project focuses on:

**Monitor → Detect → Protect → Notify**

---

## Safety Concept
The system is designed around the principle that electrical safety should be monitored continuously.

Example:

```text
Normal Operation
       ↓
Sensor Monitoring
       ↓
Condition Analysis
       ↓
Unsafe Condition?
     ↙       ↘
   No         Yes
   ↓           ↓
Continue    Disconnect Load
Monitoring      ↓
             Warning
                ↓
          Update Status
```

The actual electrical safety limits should be determined and validated based on the project's hardware, sensors, electrical ratings, and testing methodology.

---

## FAQ

### What does MySmartPlug monitor?
MySmartPlug is designed to monitor voltage, current, temperature, and appliance operating status.

### What happens when an unsafe condition is detected?
The system is designed to automatically disconnect the connected appliance and provide a warning to the user.

### Does the system require an internet connection for protection?
The project concept uses local safety logic so that the core protection mechanism can continue operating even when the network connection is unavailable.

### Can the user control the outlet?
The web interface is designed to provide remote outlet control alongside monitoring and automatic protection.

### Does the appliance automatically turn back on after a safety shutdown?
The current website concept specifies that the outlet remains disconnected until the unsafe condition has cleared and the user chooses to reconnect it.

---

## Domain
**mysmartplug.online**

---

## Project Purpose
The purpose of MySmartPlug is to develop an accessible smart electrical safety system that combines:

* Electrical monitoring
* Automatic protection
* Remote control
* Safety notifications
* IoT connectivity

The project aims to demonstrate how embedded systems, sensors, microcontrollers, and web technologies can be integrated into a single smart electrical safety solution.

---

## Development
This project is developed as an IoT and embedded systems project with a web-based interface.

The website can be opened locally using a web server during development. For example:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Make sure the required HTML, JavaScript, and image files are located in the appropriate project directory before starting the server.

---

## Project Status
**Current Status:** Website prototype

The website currently contains the main product presentation, feature sections, monitoring concept, safety workflow, FAQ, responsive layout, and interactive navigation.

Hardware integration and live sensor data can be connected to the interface as the embedded system development progresses.

---

## Disclaimer
MySmartPlug is an academic/prototype IoT project. It should not be considered a certified electrical safety device or a replacement for properly rated commercial electrical protection equipment.

All electrical hardware should be designed, tested, and operated according to appropriate electrical safety practices and component ratings.

---

## License
This project is developed for academic and educational purposes.
© 2026 MySmartPlug
