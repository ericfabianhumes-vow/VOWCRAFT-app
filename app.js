let currentDraftId = null;
let fullSpeech = "";

const generateBtn = document.getElementById('generateBtn');
const unlockBtn = document.getElementById('unlockBtn');
const errorMsg = document.getElementById('errorMsg');
const noticeMsg = document.getElementById('noticeMsg');
const output = document.getElementById('output');
const speechText = document.getElementById('speechText');
const unlockBox = document.getElementById('unlockBox');
const unlockedActions = document.getElementById('unlockedActions');

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = 'block';
}
function showNotice(msg) {
  noticeMsg.textContent = msg;
  noticeMsg.style.display = 'block';
}
function hideMessages() {
  errorMsg.style.display = 'none';
  noticeMsg.style.display = 'none';
}

function unlockUI(text) {
  fullSpeech = text;
  speechText.textContent = text;
  unlockBox.style.display = 'none';
  unlockedActions.style.display = 'flex';
}

generateBtn.addEventListener('click', async () => {
  const occasion = document.getElementById('occasion').value;
  const tone = document.getElementById('tone').value;
  const names = document.getElementById('names').value.trim();
  const details = document.getElementById('details').value.trim();
  const length = document.getElementById('length').value;

  hideMessages();

  if (!details) {
    showError('Add at least one real detail or memory — it makes a big difference.');
    return;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = 'Writing...';

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occasion, tone, names, details, length })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');

    currentDraftId = data.draftId;
    speechText.textContent = data.preview;
    output.style.display = 'block';
    unlockBox.style.display = 'block';
    unlockedActions.style.display = 'none';
    output.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err.message);
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Write my speech';
  }
});

unlockBtn.addEventListener('click', async () => {
  if (!currentDraftId) return;
  unlockBtn.disabled = true;
  unlockBtn.textContent = 'Redirecting to checkout...';
  try {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: currentDraftId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start checkout.');
    window.location.href = data.url;
  } catch (err) {
    showError(err.message);
    unlockBtn.disabled = false;
    unlockBtn.textContent = 'Unlock full speech — $12';
  }
});

document.getElementById('copyBtn')?.addEventListener('click', () => {
  navigator.clipboard.writeText(fullSpeech);
});
document.getElementById('downloadBtn')?.addEventListener('click', () => {
  const blob = new Blob([fullSpeech], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'speech.txt';
  a.click();
  URL.revokeObjectURL(url);
});

// If Stripe just redirected back here, verify the payment server-side
// before anything gets unlocked.
(async function checkForReturnFromStripe() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  const draftId = params.get('draftId');
  const canceled = params.get('canceled');

  if (canceled) {
    showNotice('Checkout was canceled — no charge was made.');
    return;
  }
  if (!sessionId || !draftId) return;

  try {
    const res = await fetch(`/api/verify-session?session_id=${encodeURIComponent(sessionId)}&draftId=${encodeURIComponent(draftId)}`);
    const data = await res.json();
    if (data.paid && data.fullSpeech) {
      currentDraftId = draftId;
      output.style.display = 'block';
      unlockUI(data.fullSpeech);
      showNotice('Payment confirmed — your full speech is unlocked below.');
    } else {
      showError('We could not confirm this payment. If you were charged, contact support with your receipt.');
    }
  } catch (err) {
    showError('Could not verify payment right now. Refresh the page to try again.');
  }
})();
