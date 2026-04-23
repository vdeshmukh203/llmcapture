---
title: 'AI Chat Capture: Integrity-Preserving Browser Instrumentation for Reproducible LLM Session Capture'
tags:
  - browser instrumentation
  - provenance logging
  - tamper-evident logging
  - LLM session capture
  - reproducibility
  - hash chain
  - Chrome extension
authors:
  - name: Vaibhav Deshmukh
    orcid: 0000-0001-6745-7062
    affiliation: 1
affiliations:
  - name: Independent Researcher, Nagpur, India
    index: 1
date: 23 April 2026
bibliography: paper.bib
---

# Summary

Browser-based large language model (LLM) interfaces—ChatGPT, Claude, and Gemini—have become primary instruments for research assistance, knowledge work, and enterprise decision support. Despite their scale of use, no standardised mechanism exists for capturing and preserving the content of these sessions in a form suitable for reproducibility, audit, or provenance research.

AI Chat Capture is a Manifest V3 Chrome extension implementing three core mechanisms to address this gap. First, a stabilisation-aware capture pipeline infers DOM quiescence following asynchronous token streaming—the fundamental technical challenge on these platforms, where the response DOM element is in continuous mutation at rates of 10–50 mutations per second. The pipeline requires two consecutive quiet-window checks before committing a capture, eliminating premature capture of partial responses. Second, an append-only SHA-256 hash-linked provenance log binds each captured record to its predecessor, enabling post-export tamper detection without server infrastructure. A standalone browser-based verifier (`chain_verifier.tsx`) allows any third party to audit an exported session log without installing the extension. Third, a platform adapter architecture isolates interface-specific DOM behaviour for each supported platform (ChatGPT, Claude, Gemini), enabling selector updates without modifying the shared core pipeline.

A proof-of-concept evaluation across three platforms achieved 100% capture completeness and zero chain failures across all 14 committed entries (ChatGPT: 6 entries, 3 turns; Claude: 4 entries, 2 turns; Gemini: 4 entries, 2 turns). Post-export tamper detection correctly identified all modified sessions tested.

# Statement of Need

Research replicating LLM-based studies cannot verify whether prompts and responses match those in a published dataset [@gao2023reproducibility; @pineau2021improving; @gundersen2018state]. Auditors examining AI-assisted decisions in enterprise workflows lack an authoritative, verifiable log [@adadi2018peeking]. Practitioners building datasets for fine-tuning or behavioural analysis must rely on manual copy-paste workflows that introduce truncation, formatting loss, and ordering errors [@wei2022chain; @gebru2021datasheets].

Existing capture approaches are insufficient. Screenshots are not machine-readable. Native export functions in ChatGPT and Claude produce static snapshots with no integrity verification. Naive DOM scraping produces duplicate and incomplete records on streaming interfaces, because the DOM is in continuous mutation during token delivery and streaming completion is not signalled by any platform-level event accessible to a content script. Web automation frameworks such as Playwright [@playwright2023] can extract DOM content but do not implement streaming stabilisation, maintain session continuity, or produce integrity-linked records. Prior work on LLM reproducibility [@kung2023chatgpt; @pineau2021improving; @stodden2016enhancing] relied on manually collected transcripts without provenance guarantees. To the authors' knowledge, no peer-reviewed system addresses the combined requirements of streaming-aware capture, tamper-evident logging, and cross-platform LLM session provenance.

AI Chat Capture is the only approach evaluated achieving both 100% capture completeness and cryptographic integrity (SHA-256). By comparison, native export achieves approximately 94% completeness but provides no integrity mechanism; manual copy-paste achieves approximately 82% with no integrity; naive DOM snapshot achieves approximately 71% with an approximately 18% duplicate rate under the tested conditions.

The framework operates entirely within the browser, requires no server infrastructure, and introduces no network interception, making deployment feasible in security-sensitive environments. Practical applications include: constructing reproducible LLM interaction datasets for publication with verifiable provenance; generating tamper-evident logs of AI-assisted decisions for regulatory or compliance review; and collecting fine-tuning data with accurate input-output alignment.

Research questions newly pursuable include: longitudinal behavioural analysis of LLM interface changes across versions; corpus construction for LLM interaction studies with cryptographic provenance guarantees; and multi-party audit workflows for AI-assisted enterprise decisions where tamper-evident logs are required.

The source code, research prototype (v12.0.0), session logs, and study manifests are archived on Zenodo [@deshmukh2026dataset; @deshmukh2026software] under open licenses, with `chain_verifier.tsx` enabling third-party verification of any exported session without installing the extension.

# Acknowledgements

This work was conducted as independent research. The author declares no funding support and no conflict of interest.

# References
