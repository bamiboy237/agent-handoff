for (const preview of document.querySelectorAll("[data-app-preview]")) {
  let visible = false;
  const syncVisibility = () => preview.contentWindow.postMessage({ type: "handoff-preview-active", active: visible }, location.origin);
  new IntersectionObserver(([entry]) => {
    visible = entry.intersectionRatio >= 0.25;
    syncVisibility();
  }, { threshold: 0.25 }).observe(preview);
  window.addEventListener("message", (event) => {
    if (event.origin === location.origin && event.source === preview.contentWindow && event.data?.type === "handoff-preview-ready") syncVisibility();
  });
}

// Copy the install command. The copy icon turns into a check for a moment.
for (const button of document.querySelectorAll("[data-copy]")) {
  const status = button.parentElement.querySelector("[data-copy-status]");
  const code = button.parentElement.querySelector("code");
  let resetTimer;

  button.addEventListener("click", async () => {
    button.classList.remove("done");
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.add("done");
      status.textContent = "Copied";
    } catch {
      // Without clipboard access, select the command so the visitor can copy it.
      getSelection().selectAllChildren(code);
      status.textContent = "Command selected. Use your device’s copy command.";
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.classList.remove("done");
      status.textContent = "";
    }, 1600);
  });
}
