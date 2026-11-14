from fastapi import FastAPI
from pydantic import BaseModel
import os

app = FastAPI()


class SkyRequest(BaseModel):
    ra: str
    dec: str
    fov: float = 0.5


@app.get("/health")
def health():
    return {"status": "Python Astropy Engine Online"}


@app.post("/process")
def process_sky(req: SkyRequest):
    os.makedirs("/data", exist_ok=True)
    return {
        "epochs": [
            {"date": "2025-03-15", "fileName": "mock1.jpeg"},
            {"date": "2025-12-14", "fileName": "mock3.jpg"}
        ],
        "subtractedFileName": "mock2.jpeg",
        "contaminationFlags": ["NONE"]
            }
