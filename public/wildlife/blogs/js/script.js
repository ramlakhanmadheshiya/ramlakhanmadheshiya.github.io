(function () {
    const activeBtn = document.querySelector(".active-btn");
    const activePage = document.querySelector(".active");
  
    // Set the active button and page based on the URL hash
    if (window.location.hash) {
      const button = document.querySelector(`[data-id="${window.location.hash.slice(1)}"]`);
      if (button) {
        activeBtn.classList.remove("active-btn");
        button.classList.add("active-btn");
  
        activePage.classList.remove("active");
        document.getElementById(button.dataset.id).classList.add("active");
      }
    }
  
    // Handle button clicks to navigate between pages
    [...document.querySelectorAll(".control")].forEach((button) => {
      button.addEventListener("click", function () {
        activeBtn.classList.remove("active-btn");
        this.classList.add("active-btn");
  
        activePage.classList.remove("active");
        document.getElementById(button.dataset.id).classList.add("active");
  
        activeBtn = this;
        activePage = document.getElementById(button.dataset.id);
  
        // Update the URL hash to reflect the current page
        window.location.hash = button.dataset.id;
      });
    });
  
    // Handle the theme toggle button
    const themeBtn = document.querySelector(".theme-btn");
    themeBtn.addEventListener("click", () => {
      document.body.classList.toggle("light-mode");
  
      // Store the theme preference in local storage
      if (document.body.classList.contains("light-mode")) {
        localStorage.setItem("theme", "light");
      } else {
        localStorage.setItem("theme", "dark");
      }
    });
  
    // Load the theme preference from local storage
    const theme = localStorage.getItem("theme");
    if (theme === "light") {
      document.body.classList.add("light-mode");
    }
  })();
  