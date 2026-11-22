"""Builds small but genuine PDF and DOCX files for tests, with no extra libraries.

Also usable as a script to write sample resumes for manual testing:
    python -m tests.samples /tmp/samples
"""

import io
import os
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


def make_pdf(pages: list[list[str]]) -> bytes:
    """A text PDF: one list of lines per page (an empty list gives a blank page)."""

    def pdf_string(s: str) -> str:
        return "(" + s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"

    objects: list[bytes] = []
    page_ids = [4 + 2 * i for i in range(len(pages))]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for pid, lines in zip(page_ids, pages):
        ops = ["BT", "/F1 12 Tf", "14 TL", "72 720 Td"]
        for line in lines:
            ops += [f"{pdf_string(line)} Tj", "T*"]
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {pid + 1} 0 R >>".encode()
        )
        objects.append(
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
        )

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref)
    )
    return out.getvalue()


def make_encrypted_pdf(lines: list[str]) -> bytes:
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(make_pdf([lines]))))
    writer.encrypt(user_password="secret", algorithm="RC4-128")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""


def make_docx(paragraphs: list[str], document_xml: str | None = None) -> bytes:
    """A DOCX with one paragraph per string; tabs and newlines become w:tab / w:br."""
    if document_xml is None:
        body = []
        for paragraph in paragraphs:
            runs = []
            for i, line in enumerate(paragraph.split("\n")):
                if i:
                    runs.append("<w:br/>")
                for j, part in enumerate(line.split("\t")):
                    if j:
                        runs.append("<w:tab/>")
                    runs.append(f'<w:t xml:space="preserve">{escape(part)}</w:t>')
            body.append(f"<w:p><w:r>{''.join(runs)}</w:r></w:p>")
        document_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{''.join(body)}</w:body></w:document>"
        )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _CONTENT_TYPES)
        archive.writestr("_rels/.rels", _RELS)
        archive.writestr("word/document.xml", document_xml)
    return out.getvalue()


SAMPLE_PDF_PAGES = [
    ["Arslan Khan", "Senior Software Engineer", "Lahore, Pakistan", "",
     "Experience", "Built payment APIs in Python and FastAPI (2019-2024)."],
    ["Education", "BS Computer Science, LUMS (2018)"],
]
SAMPLE_DOCX_PARAGRAPHS = [
    "Ahmed Raza",
    "Data Analyst\tKarachi, Pakistan",
    "Skills",
    "SQL, Python, Power BI\nTableau, Excel",
]

if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    target.mkdir(parents=True, exist_ok=True)
    (target / "arslan-resume.pdf").write_bytes(make_pdf(SAMPLE_PDF_PAGES))
    (target / "ahmed-resume.docx").write_bytes(make_docx(SAMPLE_DOCX_PARAGRAPHS))
    (target / "scanned-resume.pdf").write_bytes(make_pdf([[]]))
    (target / "protected-resume.pdf").write_bytes(make_encrypted_pdf(["Secret"]))
    (target / "notes.txt").write_bytes(b"plain text is not supported")
    (target / "fake.pdf").write_bytes(make_docx(["actually a docx"]))
    (target / "too-big.pdf").write_bytes(b"%PDF-1.4\n" + b"0" * (10 * 1024 * 1024 + 1))
    # A valid ~1.5 MB DOCX (an embedded incompressible blob), for watching upload progress.
    large = io.BytesIO(make_docx(["Large resume", "Padded with an embedded image."]))
    with zipfile.ZipFile(large, "a", zipfile.ZIP_STORED) as archive:
        archive.writestr("word/media/padding.bin", os.urandom(1_500_000))
    (target / "large-resume.docx").write_bytes(large.getvalue())
    print(f"wrote samples to {target}")
