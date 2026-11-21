(function () {
  // Adjust this number to control where each section stops after clicking navigation.
  // Higher number = section moves slightly higher on the screen.
  // Lower number = section moves slightly lower on the screen.
  const NAV_OFFSET = 40;

  const SECTIONS = ['home', 'about', 'monitoring', 'how', 'faq'];
  const links = document.querySelectorAll('.nav-link[data-page]');

  function setActive(id) {
    links.forEach(function (link) {
      link.classList.toggle('active', link.dataset.page === id);
    });
  }

  /*
   * Navigation scrolling
   * Clicking Home, About, Monitoring, How It Works, or FAQ
   * smoothly moves the selected section into position.
   */
  links.forEach(function (link) {
    link.addEventListener('click', function (event) {
      const id = link.dataset.page;
      const target = document.getElementById(id);

      if (!target) return;

      event.preventDefault();

      const targetTop =
        target.getBoundingClientRect().top +
        window.scrollY -
        NAV_OFFSET;

      window.scrollTo({
        top: targetTop,
        behavior: 'smooth'
      });

      // Update the URL without jumping the page again.
      history.replaceState(null, '', '#' + id);

      // Immediately highlight the clicked navigation item.
      setActive(id);
    });
  });

  /*
   * Scroll-spy
   * Automatically changes the active navigation button
   * when the user scrolls manually.
   */
  const observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          setActive(entry.target.id);
        }
      });
    },
    {
      rootMargin: '-45% 0px -50% 0px',
      threshold: 0
    }
  );

  SECTIONS.forEach(function (id) {
    const section = document.getElementById(id);

    if (section) {
      observer.observe(section);
    }
  });
})();


// FETCH SENSOR DATA FROM PYTHON API
async function getSensorData() {
    try {
        const response = await fetch("/api/readings", { cache: "no-store" });

        if (!response.ok) {
            throw new Error("HTTP error: " + response.status);
        }

        const data = await response.json();

        // ESP32 stopped sending data
        if (!data.online) {
            showOffline();
            return;
        }

        updateMonitoring(data);

    } catch (error) {
        console.error("Unable to retrieve sensor data:", error);
        showOffline();
    }
}

// DISPLAY SENSOR READINGS
function updateMonitoring(data) {
    document.getElementById("voltage").textContent =
        Number(data.voltage).toFixed(1);

    document.getElementById("current").textContent =
        Number(data.current).toFixed(2);

    document.getElementById("temperature").textContent =
        data.temperature_valid && data.temperature !== null
            ? Number(data.temperature).toFixed(1)
            : "--";
}

// SHOW "--" WHEN THERE IS NO LIVE DATA
function showOffline() {
    document.getElementById("voltage").textContent = "--";
    document.getElementById("current").textContent = "--";
    document.getElementById("temperature").textContent = "--";
}

// GET DATA IMMEDIATELY
getSensorData();

// REFRESH SENSOR DATA EVERY 2 SECONDS
setInterval(getSensorData, 2000);