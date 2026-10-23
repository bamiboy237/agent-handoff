// Copy the install command. The copy icon turns into a check for a moment.
for (const button of document.querySelectorAll("[data-copy]")) {
  const status = button.parentElement.querySelector("[data-copy-status]");
  const code = button.parentElement.querySelector("code");
  let resetTimer;

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.add("done");
      status.textContent = "Copied";
    } catch {
      // Without clipboard access, select the command so the visitor can copy it.
      getSelection().selectAllChildren(code);
      status.textContent = "Selected. Press Ctrl+C to copy.";
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.classList.remove("done");
      status.textContent = "";
    }, 1600);
  });
}
