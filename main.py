"""Movie recommender API (content-based, TF-IDF + cosine similarity).

Run:  uvicorn main:app --reload
Docs: http://127.0.0.1:8000/docs
"""
import os
import pickle
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sklearn.metrics.pairwise import linear_kernel

BASE = Path(__file__).parent
DATA_DIR = Path(os.getenv("DATA_DIR", BASE / "data"))
STATIC_DIR = BASE / "static"

# Genres are stored as one space-separated string, so two-word genres need care.
TWO_WORD = {"Science Fiction": "Science_Fiction", "TV Movie": "TV_Movie"}


def parse_genres(s: str) -> list[str]:
    for k, v in TWO_WORD.items():
        s = s.replace(k, v)
    return [g.replace("_", " ") for g in s.split()]


class Store:
    """Everything loaded once at startup."""


S = Store()


def load_data() -> None:
    def read(name):
        with open(DATA_DIR / f"{name}.pkl", "rb") as f:
            return pickle.load(f)  # only load pickle files you created yourself

    df = read("df").reset_index(drop=True)
    S.tfidf = read("tfidf")
    S.matrix = read("tfidf_matrix").tocsr()
    if S.matrix.shape[0] != len(df):
        raise RuntimeError("tfidf_matrix rows do not match df rows")

    df["popularity"] = pd.to_numeric(df["popularity"], errors="coerce").fillna(0.0)
    df["vote_average"] = pd.to_numeric(df["vote_average"], errors="coerce").fillna(0.0)

    S.titles = df["title"].astype(str).tolist()
    S.title_lc = df["title"].astype(str).str.lower()
    S.overview = df["overview"].fillna("").astype(str).tolist()
    S.tagline = df["tagline"].fillna("").astype(str).tolist()
    S.genres = df["genres"].fillna("").astype(str).map(parse_genres).tolist()
    S.vote = df["vote_average"].to_numpy(dtype=float)
    S.pop = df["popularity"].to_numpy(dtype=float)
    S.terms = S.tfidf.get_feature_names_out()

    names = sorted({g for gl in S.genres for g in gl})
    S.genre_names = names
    S.genre_mask = {g: np.array([g in gl for gl in S.genres]) for g in names}


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    yield


app = FastAPI(title="Movie Recommender", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"])


# ---------- helpers ----------
def movie(i: int, score: float | None = None, full: bool = False) -> dict:
    overview = S.overview[i]
    if not full and len(overview) > 260:
        overview = overview[:257].rsplit(" ", 1)[0] + "…"
    d = {
        "id": int(i),
        "title": S.titles[i],
        "genres": S.genres[i],
        "rating": round(float(S.vote[i]), 1),
        "tagline": S.tagline[i],
        "overview": overview,
    }
    if score is not None:
        d["score"] = round(float(score), 4)
    return d


def top_matches(sims: np.ndarray, n: int, min_rating: float, genre: str,
                exclude: int | None = None) -> list[int]:
    if genre and genre not in S.genre_mask:
        raise HTTPException(400, f"Unknown genre '{genre}'")
    mask = S.vote >= min_rating
    if genre:
        mask &= S.genre_mask[genre]
    s = np.where(mask, sims, -1.0)
    if exclude is not None:
        s[exclude] = -1.0

    k = min(len(s), n * 4)  # over-fetch so title de-duplication still fills n
    top = np.argpartition(-s, k - 1)[:k]
    top = top[np.argsort(-s[top])]

    picked, seen = [], set()
    for j in top:
        if s[j] <= 0:
            break
        if S.titles[j] in seen:
            continue
        seen.add(S.titles[j])
        picked.append(int(j))
        if len(picked) == n:
            break
    return picked


# ---------- API ----------
@app.get("/api/health")
def health():
    return {"status": "ok", "movies": len(S.titles)}


@app.get("/api/genres")
def genres():
    return S.genre_names


@app.get("/api/popular")
def popular(limit: int = Query(12, ge=1, le=30)):
    order = np.argsort(-S.pop)
    out, seen = [], set()
    for i in order:
        if S.titles[i] in seen or not S.genres[i]:
            continue
        seen.add(S.titles[i])
        out.append(movie(int(i)))
        if len(out) == limit:
            break
    return out


@app.get("/api/search")
def search(q: str = Query(..., min_length=1, max_length=100),
           limit: int = Query(8, ge=1, le=20)):
    """Title autocomplete: prefix matches first, then anywhere in the title."""
    q = q.strip().lower()
    if not q:
        return []
    contains = S.title_lc.str.contains(q, regex=False).to_numpy()
    cand = np.flatnonzero(contains)
    if cand.size == 0:
        return []
    starts = S.title_lc.iloc[cand].str.startswith(q).to_numpy()
    order = np.lexsort((-S.pop[cand], ~starts))  # primary: prefix, then popularity
    return [movie(int(i)) for i in cand[order][:limit]]


@app.get("/api/movie/{movie_id}")
def get_movie(movie_id: int):
    if not 0 <= movie_id < len(S.titles):
        raise HTTPException(404, "Movie not found")
    return movie(movie_id, full=True)


@app.get("/api/recommend/{movie_id}")
def recommend(movie_id: int,
              n: int = Query(12, ge=1, le=48),
              min_rating: float = Query(0, ge=0, le=10),
              genre: str = ""):
    if not 0 <= movie_id < len(S.titles):
        raise HTTPException(404, "Movie not found")
    sims = linear_kernel(S.matrix[movie_id], S.matrix).ravel()
    ids = top_matches(sims, n, min_rating, genre, exclude=movie_id)
    return {
        "seed": movie(movie_id, full=True),
        "results": [movie(j, sims[j]) for j in ids],
    }


@app.get("/api/describe")
def describe(q: str = Query(..., min_length=3, max_length=500),
             n: int = Query(12, ge=1, le=48),
             min_rating: float = Query(0, ge=0, le=10),
             genre: str = ""):
    """Free-text search: describe a plot or mood and match it against every movie."""
    vec = S.tfidf.transform([q])
    if vec.nnz == 0:
        return {"query": q, "matched_terms": [], "results": []}
    sims = linear_kernel(vec, S.matrix).ravel()
    weights = np.argsort(-vec.data)
    matched = S.terms[vec.indices[weights]][:8].tolist()
    ids = top_matches(sims, n, min_rating, genre)
    return {
        "query": q,
        "matched_terms": matched,
        "results": [movie(j, sims[j]) for j in ids],
    }


# Frontend (must be mounted last so it doesn't shadow /api routes)
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
