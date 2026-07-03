# Software Engineer — Technical Challenge

## Format

- **Duration:** 45-60 minutes
- **Format:** Live, in-person. Thinking out loud, sketching, optionally prototyping.
- **Tools:** Bring your laptop with your preferred coding environment and AI tools ready. If you prototype, use whichever LLM framework you're comfortable with — we can provide API keys.

## The Problem

We're an insurance brokerage. Our agents collect information about business clients over phone calls. That information needs to end up on ACORD forms — standardized insurance application documents that get sent to carriers for quoting.

Here's what you're working with:

- **Call transcripts** — a conversation between an agent and a business owner. Transcripts arrive via a **webhook**, and additional transcripts may arrive later with updates and corrections for the same customer.
- **ACORD forms** — the PDFs we need to fill out. Each form has named, fillable fields. See the Appendix for how form filling works.
- **LLM** — you can use a large language model to extract information from the transcripts.

Design a system that takes transcripts and produces a field-name-to-value mapping for each ACORD form.

**Constraints:**

- **A human must review and approve the extracted data before it is submitted.** The LLM's output is a draft, not a final answer — extraction from call transcripts is error-prone, and these forms get sent to carriers. The extracted fields must be reviewable and editable by a human before being passed to the form-filling service. Treat this human-in-the-loop step as a first-class part of the design: surface what was extracted and where in the transcript it came from, so a reviewer can quickly verify or correct each field.
- **Design for production.** This runs as a service: transcripts land via webhook, get processed, and are persisted for review. Think about ingestion, storage, transcripts that arrive out of order or with corrections, and how the system behaves when something fails.

Start by designing for a single transcript. If time allows, consider how the system would handle multiple transcripts for the same customer arriving over time.

## Materials

- `transcripts.json` — a call transcript for a customer (additional transcripts may be added later)
- `forms/acord_125_blank.pdf` — blank ACORD 125 (Commercial Insurance Application)
- `forms/acord_126_blank.pdf` — blank ACORD 126 (Commercial General Liability Section)
- `schema.md` — field names from both forms

## Preparation

Before the session, look through the transcript, the two blank forms, and the field list. Get a feel for what information is in the call and what the forms are asking for.

---

## Appendix: ACORD Forms & Form Filling

ACORD forms are standardized PDF documents used across the insurance industry. Each form has named, fillable fields. We've extracted those field names into `schema.md` — the nesting shows structure (indented fields are sub-fields of the parent).

We already have a form-filling service that handles the PDF side. It takes a mapping of field names to values and produces a filled PDF:

```
fill_form("acord_125", {
    "policyholder_first_name": "Mike",
    "fein": "12-3456789",
    "mailing_address": {
        "street": "PO Box 9102",
        "city": "Wilmington",
        "state": "NC",
        "zip": "28402"
    },
    "prior_carriers": [
        {
            "carrier_name": "Hartford",
            "expiration_date": "2025-09-01"
        }
    ],
    ...
})
```

You don't need to worry about how the PDF gets filled — that's handled. Your system is responsible for producing the field-name-to-value mapping that gets passed to this function.
