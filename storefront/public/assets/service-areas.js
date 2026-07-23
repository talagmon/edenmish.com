(function () {
  const section = document.querySelector(".service-areas-shell");
  if (!section) return;

  const tabs = Array.from(section.querySelectorAll('[role="tab"][data-service-view]'));
  const viewButtons = Array.from(section.querySelectorAll("[data-service-view]"));
  const panels = {
    map: document.getElementById("service-areas-map-panel"),
    list: document.getElementById("service-areas-list-panel"),
  };
  const selectedCity = document.getElementById("service-orbit-selected-city");
  const points = Array.from(section.querySelectorAll(".service-orbit-point[data-city]"));
  const cityRows = Array.from(section.querySelectorAll("[data-city-row]"));
  const searchInput = document.getElementById("service-city-search-input");
  const emptyState = section.querySelector(".service-city-empty");

  function normalize(value) {
    return String(value || "")
      .trim()
      .toLocaleLowerCase("he")
      .replace(/[-־]/g, " ");
  }

  function setView(view, options) {
    const nextView = view === "list" ? "list" : "map";
    const settings = options || {};

    Object.entries(panels).forEach(function (entry) {
      const name = entry[0];
      const panel = entry[1];
      if (panel) panel.hidden = name !== nextView;
    });

    tabs.forEach(function (tab) {
      const active = tab.dataset.serviceView === nextView;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });

    if (nextView === "list" && settings.focusSearch && searchInput) {
      window.requestAnimationFrame(function () {
        searchInput.focus();
      });
    }
  }

  function selectCity(city, focusPoint) {
    if (!city) return;
    if (selectedCity) selectedCity.textContent = city;

    let activePoint = null;
    points.forEach(function (point) {
      const active = point.dataset.city === city;
      point.classList.toggle("is-selected", active);
      point.setAttribute("aria-pressed", active ? "true" : "false");
      if (active) activePoint = point;
    });

    if (focusPoint && activePoint) {
      window.requestAnimationFrame(function () {
        activePoint.focus();
      });
    }
  }

  viewButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      setView(button.dataset.serviceView, {
        focusSearch: button.dataset.serviceView === "list" && !button.matches('[role="tab"]'),
      });
    });
  });

  tabs.forEach(function (tab, index) {
    tab.addEventListener("keydown", function (event) {
      let nextIndex = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        nextIndex = event.key === "ArrowLeft"
          ? (index + 1) % tabs.length
          : (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      }

      if (nextIndex === null) return;
      event.preventDefault();
      tabs[nextIndex].focus();
      setView(tabs[nextIndex].dataset.serviceView);
    });
  });

  points.forEach(function (point) {
    point.addEventListener("click", function () {
      selectCity(point.dataset.city, false);
    });
  });

  cityRows.forEach(function (row) {
    row.addEventListener("click", function () {
      const city = row.dataset.cityRow;
      selectCity(city, true);
      setView("map");
    });
  });

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      const query = normalize(searchInput.value);
      let visibleCount = 0;

      cityRows.forEach(function (row) {
        const visible = normalize(row.dataset.cityRow).includes(query);
        row.hidden = !visible;
        if (visible) visibleCount += 1;
      });

      if (emptyState) emptyState.hidden = visibleCount !== 0;
    });

    searchInput.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !searchInput.value) return;
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input"));
    });
  }
}());
