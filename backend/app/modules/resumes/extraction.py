"""Detect resume file types from their contents and extract readable text.

No OCR: scanned (image-only) documents are accepted but yield no text.
"""

import io
import re
import zipfile
from dataclasses import dataclass
from typing import Literal

from defusedxml import ElementTree
from pypdf import PdfReader

FileType = Literal["pdf", "docx"]

MAX_TEXT_CHARS = 500_000
# DOCX is a zip; refuse members that would decompress to something huge (zip bombs).
_MAX_DOCX_XML_BYTES = 50 * 1024 * 1024

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_DOCX_MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # legacy .doc and encrypted Office files


class ResumeFileError(Exception):
    """A user-facing problem with an uploaded file. `code` is stable; `message` is shown to users."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class UnsupportedFile(ResumeFileError):
    pass


class UnreadableFile(ResumeFileError):
    pass


@dataclass
class Extraction:
    text: str
    page_count: int | None = None


def detect_file_type(data: bytes, filename: str) -> FileType:
    """Identify the file by its bytes, and require the extension to agree."""
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in {"pdf", "docx"}:
        raise UnsupportedFile("unsupported_type", "Only PDF and DOCX files are supported.")

    if data.startswith(_OLE_MAGIC):
        raise UnreadableFile(
            "protected_or_legacy",
            "This file is password-protected or an old .doc file. "
            "Remove the password or save it as .docx or PDF, then upload it again.",
        )

    if b"%PDF-" in data[:1024]:
        detected: FileType = "pdf"
    elif data.startswith(b"PK\x03\x04") and _looks_like_docx(data):
        detected = "docx"
    else:
        raise UnsupportedFile(
            "content_mismatch",
            f"This file isn't a valid {extension.upper()} document.",
        )

    if detected != extension:
        raise UnsupportedFile(
            "content_mismatch",
            f"The file is named .{extension} but its contents are {detected.upper()}. "
            "Rename it to match, or export it again.",
        )
    return detected


def _looks_like_docx(data: bytes) -> bool:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                return False
            types = _read_member(archive, "[Content_Types].xml")
            return _DOCX_MAIN_TYPE.encode() in types
    except Exception:  # bad zip, unsupported compression, oversized member, ...
        return False


def extract_text(data: bytes, file_type: FileType) -> Extraction:
    if file_type == "pdf":
        return _extract_pdf(data)
    return _extract_docx(data)


def _extract_pdf(data: bytes) -> Extraction:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise UnreadableFile(
                "password_protected",
                "This PDF is password-protected. Remove the password and upload it again.",
            )
        pages = [page.extract_text() or "" for page in reader.pages]
    except ResumeFileError:
        raise
    except Exception:  # PdfReadError and the many other errors pypdf raises on broken files
        raise _damaged() from None
    return Extraction(text=normalize_text("\n\n".join(pages)), page_count=len(pages))


def _extract_docx(data: bytes) -> Extraction:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            root = ElementTree.fromstring(_read_member(archive, "word/document.xml"))
    except ResumeFileError:
        raise
    except Exception:  # bad zip, malformed or malicious XML (defusedxml), ...
        raise _damaged() from None

    body = root.find(f"{_W}body")
    if body is None:
        raise _damaged()
    paragraphs = [_paragraph_text(p) for p in body.iter(f"{_W}p")]
    return Extraction(text=normalize_text("\n".join(paragraphs)))


def _paragraph_text(paragraph) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{_W}t" and node.text:
            parts.append(node.text)
        elif node.tag == f"{_W}tab":
            parts.append("\t")
        elif node.tag in (f"{_W}br", f"{_W}cr"):
            parts.append("\n")
    return "".join(parts)


def _read_member(archive: zipfile.ZipFile, name: str) -> bytes:
    info = archive.getinfo(name)
    if info.file_size > _MAX_DOCX_XML_BYTES:
        raise _damaged()
    with archive.open(info) as member:
        content = member.read(_MAX_DOCX_XML_BYTES + 1)
    if len(content) > _MAX_DOCX_XML_BYTES:
        raise _damaged()
    return content


def normalize_text(text: str) -> str:
    """Make text safe to store (PostgreSQL rejects NUL) and pleasant to read."""
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:MAX_TEXT_CHARS]


def _damaged() -> UnreadableFile:
    return UnreadableFile(
        "damaged", "The file appears to be damaged and couldn't be read. Try exporting it again."
    )
