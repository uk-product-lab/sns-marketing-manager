const statusButton = document.querySelector("#statusButton");
const statusText = document.querySelector("#status");

statusButton.addEventListener("click", () => {
  const timestamp = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date());

  statusText.textContent = `動作確認済み: ${timestamp}`;
});
