import logging
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.modules.resumes.extraction import normalize_text
from app.modules.resumes.service import clean_filename
from tests.samples import (
    SAMPLE_DOCX_PARAGRAPHS,
    SAMPLE_PDF_PAGES,
    make_docx,
    make_encrypted_pdf,
    make_pdf,
)

PDF = make_pdf(SAMPLE_PDF_PAGES)
DOCX = make_docx(SAMPLE_DOCX_PARAGRAPHS)
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def new_profile(client: TestClient, name: str = "Arslan") -> str:
    return client.post("/api/v1/profiles", json={"full_name": name}).json()["id"]


def base(profile_id: str) -> str:
    return f"/api/v1/profiles/{profile_id}/resumes"


def upload(client: TestClient, profile_id: str, name: str, data: bytes, mime: str = "application/octet-stream"):
    return client.post(base(profile_id), files={"file": (name, data, mime)})


def upload_ok(client: TestClient, profile_id: str, name: str, data: bytes) -> dict:
    response = upload(client, profile_id, name, data)
    assert response.status_code == 201, response.text
    return response.json()


# --- upload and extraction --------------------------------------------------


def test_upload_pdf_extracts_text_from_all_pages(db_client: TestClient, resume_dir: Path) -> None:
    pid = new_profile(db_client)

    resume = upload_ok(db_client, pid, "Arslan CV.pdf", PDF)

    assert resume["file_type"] == "pdf"
    assert resume["original_filename"] == "Arslan CV.pdf"
    assert resume["size_bytes"] == len(PDF)
    assert resume["is_primary"] is False
    assert resume["has_text"] is True
    assert "extracted_text" not in resume  # metadata only; text is fetched separately

    text = db_client.get(f"{base(pid)}/{resume['id']}").json()["extracted_text"]
    assert "Senior Software Engineer" in text
    assert "Built payment APIs in Python and FastAPI (2019-2024)." in text  # parentheses intact
    assert "BS Computer Science, LUMS (2018)" in text  # second page
    # Stored privately as <profile>/<resume>.pdf, not under the uploaded name.
    assert (resume_dir / pid / f"{resume['id']}.pdf").read_bytes() == PDF


def test_upload_docx_extracts_paragraphs_tabs_and_breaks(db_client: TestClient, resume_dir: Path) -> None:
    pid = new_profile(db_client)

    resume = upload_ok(db_client, pid, "ahmed.docx", DOCX)

    assert resume["file_type"] == "docx"
    text = db_client.get(f"{base(pid)}/{resume['id']}").json()["extracted_text"]
    assert text == "Ahmed Raza\nData Analyst\tKarachi, Pakistan\nSkills\nSQL, Python, Power BI\nTableau, Excel"
    assert (resume_dir / pid / f"{resume['id']}.docx").exists()


def test_pdf_without_text_is_accepted_but_flagged(db_client: TestClient) -> None:
    pid = new_profile(db_client)

    resume = upload_ok(db_client, pid, "scan.pdf", make_pdf([[]]))

    assert resume["has_text"] is False and resume["text_length"] == 0


def test_path_in_filename_is_dropped(db_client: TestClient, resume_dir: Path) -> None:
    pid = new_profile(db_client)

    resume = upload_ok(db_client, pid, "../../etc/evil name.pdf", PDF)

    assert resume["original_filename"] == "evil name.pdf"
    files = list(resume_dir.rglob("*"))
    assert files and all(resume_dir in f.parents for f in files)  # nothing outside storage


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("C:\\Users\\me\\CV.pdf", "CV.pdf"),
        ("bell\x07 and\ttab.pdf", "bell and tab.pdf"),
        ("  spaced   out .docx ", "spaced out .docx"),
        ("", "resume"),
        (None, "resume"),
        ("x" * 300 + ".pdf", "x" * 251 + ".pdf"),  # 255 characters, extension kept
    ],
)
def test_clean_filename(raw: str | None, clean: str) -> None:
    assert clean_filename(raw) == clean


def test_normalize_text_removes_nul_and_extra_blank_lines() -> None:
    assert normalize_text("a\x00b\r\n\r\n\r\n\r\nc  \n") == "ab\n\nc"


# --- multiple resumes, primary ----------------------------------------------


def test_profile_can_have_multiple_resumes(db_client: TestClient) -> None:
    pid = new_profile(db_client)
    first = upload_ok(db_client, pid, "a.pdf", PDF)
    second = upload_ok(db_client, pid, "b.docx", DOCX)

    listed = db_client.get(base(pid)).json()

    assert [r["id"] for r in listed] == [first["id"], second["id"]]
    assert all("extracted_text" not in r for r in listed)


def test_only_one_primary_resume_per_profile(db_client: TestClient) -> None:
    pid = new_profile(db_client)
    first = upload_ok(db_client, pid, "a.pdf", PDF)
    second = upload_ok(db_client, pid, "b.docx", DOCX)

    assert db_client.put(f"{base(pid)}/{first['id']}/primary").json()["is_primary"] is True
    assert db_client.put(f"{base(pid)}/{second['id']}/primary").json()["is_primary"] is True

    primaries = [r["id"] for r in db_client.get(base(pid)).json() if r["is_primary"]]
    assert primaries == [second["id"]]

    # Setting the same one again is harmless.
    assert db_client.put(f"{base(pid)}/{second['id']}/primary").status_code == 200


def test_primary_can_be_unset(db_client: TestClient) -> None:
    pid = new_profile(db_client)
    resume = upload_ok(db_client, pid, "a.pdf", PDF)
    db_client.put(f"{base(pid)}/{resume['id']}/primary")

    response = db_client.delete(f"{base(pid)}/{resume['id']}/primary")

    assert response.status_code == 200 and response.json()["is_primary"] is False


def test_primary_is_per_profile(db_client: TestClient) -> None:
    arslan, ahmed = new_profile(db_client, "Arslan"), new_profile(db_client, "Ahmed")
    a = upload_ok(db_client, arslan, "a.pdf", PDF)
    b = upload_ok(db_client, ahmed, "b.pdf", PDF)

    db_client.put(f"{base(arslan)}/{a['id']}/primary")
    db_client.put(f"{base(ahmed)}/{b['id']}/primary")

    assert db_client.get(base(arslan)).json()[0]["is_primary"] is True
    assert db_client.get(base(ahmed)).json()[0]["is_primary"] is True


# --- delete -----------------------------------------------------------------


def test_delete_removes_row_and_file(db_client: TestClient, resume_dir: Path) -> None:
    pid = new_profile(db_client)
    keep = upload_ok(db_client, pid, "keep.pdf", PDF)
    gone = upload_ok(db_client, pid, "gone.pdf", PDF)

    assert db_client.delete(f"{base(pid)}/{gone['id']}").status_code == 204

    assert [r["id"] for r in db_client.get(base(pid)).json()] == [keep["id"]]
    assert not (resume_dir / pid / f"{gone['id']}.pdf").exists()
    assert (resume_dir / pid / f"{keep['id']}.pdf").exists()


def test_deleting_profile_removes_its_resumes_and_files(db_client: TestClient, resume_dir: Path) -> None:
    arslan, ahmed = new_profile(db_client, "Arslan"), new_profile(db_client, "Ahmed")
    upload_ok(db_client, arslan, "a.pdf", PDF)
    kept = upload_ok(db_client, ahmed, "b.pdf", PDF)

    assert db_client.delete(f"/api/v1/profiles/{arslan}").status_code == 204

    assert not (resume_dir / arslan).exists()
    assert (resume_dir / ahmed / f"{kept['id']}.pdf").exists()
    assert db_client.get(base(arslan)).status_code == 404


# --- separation between profiles ---------------------------------------------


@pytest.mark.parametrize(
    ("method", "suffix"),
    [("get", ""), ("delete", ""), ("put", "/primary"), ("delete", "/primary")],
)
def test_resume_is_unreachable_through_another_profile(
    db_client: TestClient, method: str, suffix: str
) -> None:
    arslan, ahmed = new_profile(db_client, "Arslan"), new_profile(db_client, "Ahmed")
    resume = upload_ok(db_client, arslan, "a.pdf", PDF)

    response = getattr(db_client, method)(f"{base(ahmed)}/{resume['id']}{suffix}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Resume not found"}
    # Untouched for its real owner.
    owned = db_client.get(f"{base(arslan)}/{resume['id']}").json()
    assert owned["is_primary"] is False
    assert db_client.get(base(ahmed)).json() == []


def test_unknown_profile_returns_404(db_client: TestClient) -> None:
    missing = str(uuid.uuid4())

    assert db_client.get(base(missing)).json() == {"detail": "Profile not found"}
    assert upload(db_client, missing, "a.pdf", PDF).status_code == 404


def test_unknown_resume_returns_404(db_client: TestClient) -> None:
    pid = new_profile(db_client)

    response = db_client.get(f"{base(pid)}/{uuid.uuid4()}")

    assert response.status_code == 404 and response.json() == {"detail": "Resume not found"}


# --- validation -------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "data", "status", "message"),
    [
        ("empty.pdf", b"", 422, "empty"),
        ("notes.txt", b"just text", 415, "Only PDF and DOCX"),
        ("resume", PDF, 415, "Only PDF and DOCX"),
        ("image.png", b"\x89PNG\r\n\x1a\n" + b"0" * 100, 415, "Only PDF and DOCX"),
        ("fake.pdf", b"this is not a pdf at all", 415, "isn't a valid PDF"),
        ("fake.docx", b"PK\x03\x04 not really a zip", 415, "isn't a valid DOCX"),
        ("swapped.pdf", DOCX, 415, "contents are DOCX"),
        ("swapped.docx", PDF, 415, "contents are PDF"),
        ("broken.pdf", b"%PDF-1.4\n garbage garbage", 422, "damaged"),
        ("truncated.pdf", PDF[: len(PDF) // 2], 422, "damaged"),
        ("protected.pdf", make_encrypted_pdf(["Secret"]), 422, "password-protected"),
        ("legacy.doc.docx", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 512, 422, "password-protected"),
        (
            "badxml.docx",
            make_docx([], document_xml="<w:document><unclosed>"),
            422,
            "damaged",
        ),
    ],
)
def test_invalid_files_are_rejected_clearly(
    db_client: TestClient, resume_dir: Path, name: str, data: bytes, status: int, message: str
) -> None:
    pid = new_profile(db_client)

    response = upload(db_client, pid, name, data)

    assert response.status_code == status, response.text
    assert message in response.json()["detail"]
    assert db_client.get(base(pid)).json() == []
    assert list(resume_dir.rglob("*.*")) == []  # nothing stored


def test_xml_entity_expansion_is_refused(db_client: TestClient) -> None:
    pid = new_profile(db_client)
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa">'
        '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>"
    )

    response = upload(db_client, pid, "bomb.docx", make_docx([], document_xml=bomb))

    assert response.status_code == 422


def test_file_over_10_mb_is_rejected(db_client: TestClient) -> None:
    pid = new_profile(db_client)
    too_big = b"%PDF-1.4\n" + b"0" * (10 * 1024 * 1024)

    response = upload(db_client, pid, "big.pdf", too_big)

    assert response.status_code == 413
    assert "10 MB" in response.json()["detail"]


def test_missing_file_field_returns_422(db_client: TestClient) -> None:
    pid = new_profile(db_client)

    assert db_client.post(base(pid)).status_code == 422


# --- privacy ----------------------------------------------------------------


def test_logs_never_contain_resume_text_or_filename(
    db_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    pid = new_profile(db_client)
    secret = "UNIQUE-SECRET-PHONE-0300-9999999"
    caplog.set_level(logging.DEBUG)

    resume = upload_ok(db_client, pid, "Secret Name CV.docx", make_docx([secret]))
    db_client.get(f"{base(pid)}/{resume['id']}")
    upload(db_client, pid, "Secret Name CV.pdf", b"%PDF-1.4 broken " + secret.encode())

    assert secret not in caplog.text
    assert "Secret Name" not in caplog.text
