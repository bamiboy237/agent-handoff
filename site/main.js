// Copy buttons for the install command.
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "copied";
    } catch {
      button.textContent = "press ⌘C";
    }
    setTimeout(() => (button.textContent = "copy"), 1600);
  });
}
