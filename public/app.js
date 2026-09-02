const SUPABASE_FUNCTION_URL =
  "https://quylfcqnzubxedlatzpv.supabase.co/functions/v1/super-responder";

const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_9Nl91eoKWdraNH_kw2cCIg_GHRn-IJJ";

const params = new URLSearchParams(window.location.search);
const macAddress = params.get("mac_address")?.trim() || "";

const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const messages = document.getElementById("messages");
const sendButton = document.getElementById("send-button");
const statusText = document.getElementById("status");

function addMessage(text, type) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${type}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

function setLoading(loading) {
  sendButton.disabled = loading;
  input.disabled = loading;
  sendButton.textContent = loading ? "..." : "إرسال";
}

async function sendMessage(message) {
  const response = await fetch(SUPABASE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "apikey": SUPABASE_PUBLISHABLE_KEY
    },
    body: JSON.stringify({
      mac_address: macAddress,
      message
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      data?.raw ||
      `HTTP ${response.status}`
    );
  }

  return data;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = input.value.trim();
  if (!message) return;

  addMessage(message, "user");
  input.value = "";
  setLoading(true);
  statusText.textContent = "جارٍ الرد...";

  try {
    const data = await sendMessage(message);

    const reply =
      data.reply ??
      data.response ??
      data.message ??
      data.text ??
      "تم استلام رسالتك.";

    addMessage(String(reply), "support");
    statusText.textContent = "متصل";
  } catch (error) {
    console.error(error);
    addMessage(
      `خطأ الاتصال: ${error.message}`,
      "support"
    );
    statusText.textContent = "تعذر الاتصال";
  } finally {
    setLoading(false);
    input.focus();
  }
});
