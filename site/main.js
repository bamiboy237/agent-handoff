// Copy the install command. The label blurs between "copy" and "copied".
for (const button of document.querySelectorAll("[data-copy]")) {
  const label = button.querySelector(".copy-label");
  let resetTimer;

  const swap = (text) => {
    label.classList.add("swapping");
    setTimeout(() => {
      label.textContent = text;
      label.classList.remove("swapping");
    }, 120);
  };

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      swap("copied");
    } catch {
      swap(/Mac|iPhone|iPad/.test(navigator.platform) ? "press ⌘C" : "press Ctrl+C");
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => swap("copy"), 1600);
  });
}
