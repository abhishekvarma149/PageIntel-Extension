import asyncio
import hashlib
import json
import os
import redis.asyncio as redis

from typing import Optional
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import AsyncOpenAI
from pydantic import BaseModel

from langchain_community.tools import DuckDuckGoSearchRun
from langchain_core.documents import Document
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_qdrant import QdrantVectorStore
from langchain_text_splitters import RecursiveCharacterTextSplitter

from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue, PayloadSchemaType

load_dotenv()

# LLM
mesh_client = AsyncOpenAI(
    api_key=os.getenv("MESH_API"),
    base_url="https://api.meshapi.ai/v1"
)

DEFAULT_MODEL = "openai/gpt-4o"

AVAILABLE_MODELS = [
    {"id": "openai/gpt-4o", "name": "GPT-4o"},
    {"id": "openai/gpt-4o-mini", "name": "GPT-4o Mini"},
    {"id": "openai/gpt-4.1", "name": "GPT-4.1"},
    {"id": "anthropic/claude-sonnet-4.5", "name": "Claude Sonnet 4.5"},
    {"id": "anthropic/claude-haiku-4.5", "name": "Claude Haiku 4.5"},
    {"id": "google/gemini-2.5-flash", "name": "Gemini 2.5 Flash"},
    {"id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro"},
    {"id": "meta-llama/llama-3.3-70b-instruct", "name": "Llama 3.3 70B"},
    {"id": "mistralai/mistral-large-3", "name": "Mistral Large 3"},
    {"id": "deepseek/deepseek-r1", "name": "DeepSeek R1"},
]

NO_TOOLS_MODELS = {
    "deepseek/deepseek-r1",
    "deepseek/deepseek-r1-0528"
}

WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the web when the document context is insufficient.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query"
                }
            },
            "required": ["query"]
        }
    }
}

# Embeddings
emb_model = HuggingFaceEmbeddings(
    model_name="BAAI/bge-small-en"
)

# Qdrant
qdrant = QdrantClient(
    url=os.getenv("QDRANT_URL"),
    api_key=os.getenv("QDRANT_API_KEY")
)

COLLECTION = "pageintel"

# Redis
redis_client = redis.from_url(
    os.getenv("REDIS_URL", "redis://localhost:6379"),
    decode_responses=True
)

# FastAPI
app = FastAPI(title="PageIntel Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)


class ChatRequest(BaseModel):
    text: str
    query: str
    session_id: str
    model: Optional[str] = DEFAULT_MODEL


class CompareRequest(BaseModel):
    text: str
    query: str
    session_id: str
    model_a: Optional[str] = DEFAULT_MODEL
    model_b: Optional[str] = "anthropic/claude-sonnet-4.5"


# Redis memory
async def get_history(session_id: str):
    messages = await redis_client.lrange(
        f"session:{session_id}", 0, -1
    )
    return [json.loads(message) for message in messages]


async def save_history(session_id: str, query: str, answer: str):
    key = f"session:{session_id}"

    await redis_client.rpush(
        key,
        json.dumps({"user": query, "ai": answer})
    )

    await redis_client.ltrim(key, -5, -1)
    await redis_client.expire(key, 86400)


def format_history(history):
    return "".join(
        f"User: {item['user']}\nAI: {item['ai']}\n"
        for item in history
    )


# Qdrant
def document_id(text: str, session_id: str):
    # Session ID is already a unique hash of the URL.
    # We use it directly so we don't re-index identical pages if minor dynamic text changes.
    return session_id


def document_exists(doc_id: str):
    try:
        points, _ = qdrant.scroll(
            collection_name=COLLECTION,
            scroll_filter=Filter(
                must=[
                    FieldCondition(
                        key="metadata.document_id",
                        match=MatchValue(value=doc_id)
                    )
                ]
            ),
            limit=1
        )
        return bool(points)
    except Exception:
        return False


def index_document(text: str, session_id: str, doc_id: str):
    if document_exists(doc_id):
        return

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=500,
        chunk_overlap=50
    )

    documents = [
        Document(
            page_content=chunk,
            metadata={
                "document_id": doc_id,
                "session_id": session_id,
                "chunk_index": i
            }
        )
        for i, chunk in enumerate(splitter.split_text(text))
    ]

    QdrantVectorStore.from_documents(
        documents=documents,
        embedding=emb_model,
        url=os.getenv("QDRANT_URL"),
        api_key=os.getenv("QDRANT_API_KEY"),
        collection_name=COLLECTION
    )

    try:
        qdrant.create_payload_index(
            collection_name=COLLECTION,
            field_name="metadata.document_id",
            field_schema=PayloadSchemaType.KEYWORD
        )
    except Exception as e:
        print(f"[warn] Failed to create payload index: {e}")


def retrieve_context(text: str, query: str, session_id: str):
    doc_id = document_id(text, session_id)

    index_document(text, session_id, doc_id)

    store = QdrantVectorStore(
        client=qdrant,
        collection_name=COLLECTION,
        embedding=emb_model
    )

    docs = store.similarity_search(
        query,
        k=3,
        filter=Filter(
            must=[
                FieldCondition(
                    key="metadata.document_id",
                    match=MatchValue(value=doc_id)
                )
            ]
        )
    )

    return "\n\n".join(doc.page_content for doc in docs)


# LLM
async def ask_model(model, context, query, history):
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful assistant. "
                "Answer using the provided document context "
                "and conversation history. "
                "If the context is insufficient, use web_search "
                "when available. Be direct."
            )
        },
        {
            "role": "user",
            "content": (
                f"History:\n{history}\n\n"
                f"Document Context:\n{context}\n\n"
                f"Question:\n{query}"
            )
        }
    ]

    supports_tools = model not in NO_TOOLS_MODELS

    try:
        kwargs = {
            "model": model,
            "messages": messages,
            "temperature": 0
        }

        if supports_tools:
            kwargs["tools"] = [WEB_SEARCH_TOOL]
            kwargs["tool_choice"] = "auto"

        response = await mesh_client.chat.completions.create(**kwargs)
        message = response.choices[0].message

        if supports_tools and message.tool_calls:
            args = json.loads(
                message.tool_calls[0].function.arguments
            )

            search_query = args.get("query", query)
            results = await asyncio.to_thread(DuckDuckGoSearchRun().run, search_query)

            response = await mesh_client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": "Answer using the web search results."
                    },
                    {
                        "role": "user",
                        "content": (
                            f"History:\n{history}\n\n"
                            f"Search Results:\n{results}\n\n"
                            f"Question:\n{query}"
                        )
                    }
                ],
                temperature=0
            )

            return response.choices[0].message.content

        return message.content

    except Exception as error:
        print(f"[warn] {model}: {error}")

        response = await mesh_client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0
        )

        return response.choices[0].message.content


@app.get("/health")
async def health():
    try:
        await redis_client.ping()
        redis_status = "ok"
    except Exception:
        redis_status = "error"

    try:
        qdrant.get_collections()
        qdrant_status = "ok"
    except Exception:
        qdrant_status = "error"

    return {
        "status": "ok",
        "redis": redis_status,
        "qdrant": qdrant_status
    }


@app.get("/models")
def get_models():
    return {"models": AVAILABLE_MODELS}


@app.get("/history/{session_id}")
async def get_session_history(session_id: str):
    history = await get_history(session_id)

    return {
        "session_id": session_id,
        "history": history
    }


@app.delete("/history/{session_id}")
async def delete_session_history(session_id: str):
    await redis_client.delete(f"session:{session_id}")
    return {"status": "ok"}


@app.post("/chat")
async def chat(payload: ChatRequest):
    history = await get_history(payload.session_id)

    context = await asyncio.to_thread(
        retrieve_context,
        payload.text,
        payload.query,
        payload.session_id
    )

    answer = await ask_model(
        payload.model or DEFAULT_MODEL,
        context,
        payload.query,
        format_history(history)
    )

    await save_history(
        payload.session_id,
        payload.query,
        answer
    )

    return JSONResponse({"answer": answer})


@app.post("/compare")
async def compare(payload: CompareRequest):
    history = await get_history(payload.session_id)
    history_text = format_history(history)

    context = await asyncio.to_thread(
        retrieve_context,
        payload.text,
        payload.query,
        payload.session_id
    )

    answer_a, answer_b = await asyncio.gather(
        ask_model(
            payload.model_a or DEFAULT_MODEL,
            context,
            payload.query,
            history_text
        ),
        ask_model(
            payload.model_b or "anthropic/claude-sonnet-4.5",
            context,
            payload.query,
            history_text
        )
    )

    combined = (
        f"[{payload.model_a}]: {answer_a}\n\n"
        f"[{payload.model_b}]: {answer_b}"
    )

    await save_history(
        payload.session_id,
        payload.query,
        combined
    )

    return {
        "answer_a": answer_a,
        "answer_b": answer_b
    }