# PageIntel

A Chrome extension that lets you chat with any webpage using AI. Open any page, click the extension, and ask questions. It reads the page and answers using the content. If the page doesn't have the answer, it searches the web automatically.

Supports **10 models** (GPT-4o, Claude, Gemini, Llama, Mistral, DeepSeek) via [Mesh API](https://api.meshapi.ai), with a **side-by-side comparison mode** to run two models at once.

Conversations are **persistent and website-specific**. Chatting on one website creates a dedicated session, which seamlessly restores whenever you return to that site!

---

## How It Works

1. You click "Ask" in the extension popup.
2. The extension extracts all visible text from the current tab (`document.body.innerText`).
3. That text gets sent to the Python backend along with your question and a unique session hash based on the URL.
4. The backend chunks the text, embeds it, and stores/retrieves the top 3 most relevant chunks using Qdrant (RAG).
5. The context + your question + your Redis-backed conversation history gets sent to whichever model you picked.
6. If the model can't find the answer in the page, it automatically calls DuckDuckGo search and tries again.
7. The answer streams back to the popup word-by-word.

**Compare mode** runs two models on the same query in parallel and shows both answers side by side.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Extension | HTML, CSS, JavaScript (Chrome Manifest V3) |
| Backend | Python, FastAPI |
| LLM Gateway | [Mesh API](https://api.meshapi.ai) (OpenAI-compatible) |
| RAG / Vector Store | Qdrant + `BAAI/bge-small-en` embeddings |
| Memory | Redis (persistent website-specific chat history) |
| Web Search | DuckDuckGo (fallback tool) |

---

## Setup

### 1. Requirements
- Python 3.11+
- Redis (running locally or via URL)
- Qdrant (running locally or via Qdrant Cloud)

### 2. Backend Environment

Create a `.env` file in the project root:
```env
MESH_API=your_mesh_api_key_here
REDIS_URL=redis://localhost:6379
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=optional_qdrant_api_key
```

### 3. Start Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd backend
uvicorn main:app --reload
```

### 4. Chrome Extension

1. Go to `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select the `extension/` folder

That's it. The backend runs on `http://127.0.0.1:8000` and the extension talks to it directly.

---

## Available Models

| Model | ID |
|---|---|
| GPT-4o | `openai/gpt-4o` |
| GPT-4o Mini | `openai/gpt-4o-mini` |
| GPT-4.1 | `openai/gpt-4.1` |
| Claude Sonnet 4.5 | `anthropic/claude-sonnet-4.5` |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |
| Mistral Large 3 | `mistralai/mistral-large-3` |
| DeepSeek R1 | `deepseek/deepseek-r1` |

---

## Project Structure

```text
PageIntel/
├── backend/
│   └── main.py           # FastAPI app — /models, /chat, /compare, /history
├── extension/
│   ├── manifest.json     # Chrome permissions
│   ├── popup.html        # Extension UI
│   └── popup.js          # Ask, Compare, and Session logic
├── requirements.txt      # Python dependencies
├── .gitignore
└── .env                  # Environment variables
```