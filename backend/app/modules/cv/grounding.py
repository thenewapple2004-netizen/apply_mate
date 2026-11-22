"""Cheap safeguard against AI hallucination: flag named facts in a draft that
don't appear in the resume text, so the user checks them before confirming.

This doesn't prove correctness; it only highlights likely inventions.
"""

import re
import unicodedata

from app.modules.cv.schemas import CVData


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def find_ungrounded(data: CVData, resume_text: str) -> list[str]:
    haystack = f" {_norm(resume_text)} "

    def missing(value: str | None) -> bool:
        if not value:
            return False
        needle = _norm(value)
        return bool(needle) and f" {needle} " not in haystack

    warnings: list[str] = []
    for job in data.work_experience:
        if missing(job.company):
            warnings.append(f'Company "{job.company}" wasn\'t found in the resume text.')
        if missing(job.title):
            warnings.append(f'Job title "{job.title}" wasn\'t found in the resume text.')
    for edu in data.education:
        if missing(edu.institution):
            warnings.append(f'Institution "{edu.institution}" wasn\'t found in the resume text.')
    for cert in data.certifications:
        if missing(cert.name):
            warnings.append(f'Certification "{cert.name}" wasn\'t found in the resume text.')
    for project in data.projects:
        if missing(project.name):
            warnings.append(f'Project "{project.name}" wasn\'t found in the resume text.')
    return warnings
