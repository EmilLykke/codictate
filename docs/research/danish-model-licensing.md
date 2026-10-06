# Licensing: what Edda, ekko-v1-tiny and ekko-pnc require

Research for [#74](https://github.com/EmilLykke/codictate/issues/74), part of the Danish models map [#66](https://github.com/EmilLykke/codictate/issues/66).
Sources were read on 2026-10-06. **This is a compliance checklist, not legal advice.** Wherever the sources do not settle a point, it is marked **unverified** or **interpretation**. Gaps have not been filled from memory.

## Answer in brief

- **Edda v0.2** (Apache-2.0, with Whisper's MIT base) is the cleanest of the three. Apache-2.0 and MIT need notices, the license texts, and a "we changed these files" note on our GGML conversion. The CoRal pass-through *probably* does not apply, because the CoRal licensor released Edda itself under Apache-2.0. That is an interpretation, and it is worth a one-line written confirmation from the Alexandra Institute. FTSpeech made up 43% of Edda's training steps, so the FTSpeech question below applies to Edda as well.
- **ekko-v1-tiny** comes with four sets of terms at once: the NVIDIA Open Model License, CC BY 4.0 for RyeAI's changes, the CoRal license (restrictions passed through), and the FTSpeech statement plus Folketinget's terms. Shipping it means a Notice file, copies of all four, and a legal agreement that carries the CoRal use restrictions.
- **ekko-pnc** comes with CC BY 4.0 (its own and the base model's), the CoRal section 4 restrictions, and the FTSpeech notices.
- **hviske-v5-tiny (already shipped)** is a CoRal-derived model too, and today's Mirror does not pass the CoRal terms through. It is also **CC BY-NC 4.0**, which is a **blocker if Codictate is, or becomes, commercial**.
- **Possible blocker for every CoRal-derived model (hviske, ekko, ekko-pnc):** CoRal's Attachment A 3(a) forbids disseminating machine-generated content "without expressly and intelligibly disclaiming that it is machine-generated". Read literally, that covers every dictated transcript. Get a written answer from the Alexandra Institute before relying on any reading of it.
- **FTSpeech:** the Folketinget TV licence says "you have no rights to make changes, further develop the TV productions ... or create derivative works", and the FTSpeech paper says its materials are "freely available for research purposes only". This risk sits upstream, with the model publishers, but it reaches every model here. It needs a human or legal read.

## Sources

| Source | Revision / snapshot | Notes |
| --- | --- | --- |
| [RyeAI/ekko-v1-tiny](https://huggingface.co/RyeAI/ekko-v1-tiny) | HEAD `27ff726`, artifact pin `e37e698` | `MODEL_LICENSE.md`, `NOTICE`, `LICENSES/*`. The license files are byte-identical at both revisions. |
| [RyeAI/ekko-pnc](https://huggingface.co/RyeAI/ekko-pnc) | HEAD `de465d1`, artifact pin `d312954` | Same: the license files are identical at both revisions. |
| [danish-foundation-models/edda-v0.2](https://huggingface.co/danish-foundation-models/edda-v0.2) | `98ec5ee` | The repo has **no LICENSE or NOTICE file**, only `license: apache-2.0` in the card. |
| [CoRal-project/coral-v3](https://huggingface.co/datasets/CoRal-project/coral-v3) `LICENSE` | `01f7c93` | sha256 `ee93c98d…`. **Byte-identical** to `LICENSES/CORAL-LICENSE` in both RyeAI repos. |
| `LICENSES/NVIDIA-OPEN-MODEL-LICENSE.pdf` (ekko-v1-tiny) | "Version Release Date: October 24, 2025" | Matches the date on the [live NVIDIA page](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/). |
| [nvidia/parakeet-rnnt-110m-da-dk](https://huggingface.co/nvidia/parakeet-rnnt-110m-da-dk) | `ea77aca` | The base of ekko-v1-tiny. Its own training data includes CoRal (read aloud), Common Voice 17, and Granary Danish. |
| [syvai/hviske-v5-tiny](https://huggingface.co/syvai/hviske-v5-tiny), [hviske-v5.3](https://huggingface.co/syvai/hviske-v5.3), [hviske-v5.1](https://huggingface.co/syvai/hviske-v5.1) | `361051e`, `5d1a098` | Lineage and training data |
| Folketinget TV "Deling og rettigheder" | **Wayback snapshot 2025-09-05** (`web.archive.org/web/20250905144011/...`) | The live page returns HTTP 403 to curl and WebFetch, for both the Danish and English URLs. |
| Folketinget "Åbne data" terms | Wayback snapshot 2025-04-03 | The live page also returns 403. |
| [FTSpeech paper, arXiv 2005.12368](https://arxiv.org/abs/2005.12368) and [ftspeech.github.io](https://ftspeech.github.io/) `LICENSE.md` | GitHub commit `4c2641d` (2020-09-14) | `LICENSE.md` is identical to RyeAI's `LICENSES/FTSPEECH-LICENSE.md`. |
| Mozilla Data Collective public API `mozilladatacollective.com/api/datasets` | 2026-10-06 | Common Voice Danish records |

## 1. CoRal-v3 license (the pass-through)

**Name.** The dataset card calls it "an OpenRAIL-D license, adapted from OpenRAIL-M". The license text itself says it is "based on "AI PUBS OPEN RAIL-M LICENSE" ... modified to fit the licensing of Data". Licensor: Alexandra Instituttet A/S.

**Who it reaches.** Models count as derived material:

> (a) "Adapted Material" means material (including Models) derived from or based upon the Licensed Material.

> (k) "You" (or "Your") means an individual or legal entity exercising permissions granted by this License and/or making use of the Licensed Material for whichever purpose and in any field of use, including usage of the Licensed Material or Adapted Material in an end-use application - e.g. chatbot, translator, image generator, speech recognizer, speech generator, adapter etc.

> (c) "Distribution" means any transmission, reproduction, publication or other sharing of the Licensed Material or the Adapted Material to a third party, including providing [it] as a hosted service ...

ekko-v1-tiny, ekko-pnc and hviske-v5-tiny (see §6) are Adapted Material. A dictation app is a "speech recognizer", which the definition of "You" names explicitly. So Codictate is a "You" even when it does not re-host a file. Hosting a Mirror is also "Distribution".

**Obligations on Distribution (section 3), verbatim:**

> (a) Use-based restrictions in paragraph 4 MUST be included as an enforceable provision by You in any type of legal agreement (e.g. a license) governing the use and/or distribution of the Licensed Material or the Adapted Material, and You shall give notice to subsequent users You Distribute to, that the Licensed Material or the Adapted Material are subject to paragraph 4.
> (b) You must give any Third Party recipients of the Licensed Material or the Adapted Material a copy of this License;
> (c) You must cause any modified files to carry prominent notices stating that You changed the files;
> (d) You must retain all copyright, patent, trademark, and attribution notices ...

> 4. ... You shall require all of Your users who use the Licensed Material or the Adapted Material to comply with the terms of this paragraph 4.

**Use restrictions to pass on.** There are two lists, and both must be passed on:

- **Addition 4** (first page of the license):
  - (a) impersonation, "including (but not limited to) the creation of synthetic speech (i) emulating a specific natural person or (ii) which is found to be similar to a specific natural person's speech".
  - (b) "To detect or infer aspects and/or features of an identity of any natural persons, such as name, family name, address, gender, sexual orientation, race, religion, age, location ..., skin color, society or political affiliations, employment status ..., and health and medical conditions."
- **Attachment A:**
  - 1(a) legal compliance
  - 2(a) to 2(g): harm and discrimination
  - 3(a) to 3(c): transparency

**Attachment A 3(a), the clause that matters for dictation:**

> You agree not to use the Licensed Material or the Adapted Material in any of the following ways: ... 3. Transparency (a) To generate or disseminate machine-generated information or content in any medium without expressly and intelligibly disclaiming that it is machine-generated;

**Other terms.** Danish law. Mediation, then arbitration by the Danish Institute of Arbitration, with three arbitrators, seated in Aarhus, in English. Addition 3 makes the license "automatically become null and void" if processing violates applicable law. Section 6 reserves the right to "restrict (remotely or otherwise) usage".

### What compliance looks like for a dictation app (interpretation)

1. **A legal agreement that contains the restrictions.** Codictate ships under Apache-2.0 for its code and has no EULA or terms of use (a search of the repo, including `installer/` and `src/`, found none). Apache-2.0 does not govern the model weights. Section 3(a) wants the restrictions in "any type of legal agreement" and in an *enforceable* form. A README alone is weak. The practical form is a short **Model Terms** that the user accepts **before** a CoRal-derived model downloads. It would say:
   - "This model is subject to the CoRal license. You agree not to use it for [Addition 4 + Attachment A], and to require the same of anyone you share it with."
   - It links the full license and records the acceptance.

   The same text then goes into an EULA or terms of use if Codictate ever gets one.
2. **A copy of the license** in every Mirror repo, and reachable from the app (bundled under `licenses/`, the way `docs/licenses/s1-mini` is).
3. **The modified-files notice** on anything Codictate converts or re-quantizes.
4. **Attachment A 3(a), machine-generated content.** No reading of this clause is safe without the licensor:
   - **Reading A:** the content is the speaker's own words, and the model only transcribes them, so the clause, which comes from generative-model licenses, does not bite. Supporting this: the Alexandra Institute ships its own ASR models (`roest-v3-whisper-1.5b`, `license: openrail`) under this license. Its model card describes the license as one "which allows commercial use with few restrictions (speech synthesis and biometric identification)", and that does not mention disclaiming transcripts. That is an inference from context, not a waiver.
   - **Reading B:** a literal reading. Every transcript a user pastes into an email is "machine-generated content", and section 4 requires Codictate to make users comply. A dictation app cannot reasonably label every insertion.
   - **Action:** ask the Alexandra Institute (CoRal project) in writing whether ASR transcription of the user's own speech falls under 3(a). Until there is an answer, pass the clause through verbatim in the Model Terms so the obligation sits with the user, and treat Reading B as the open risk. This already applies to hviske, which is shipped (see §6).
5. **Addition 4(b), identity inference.** No Codictate feature should infer speaker gender, age, accent region and so on from audio processed by these models. Speaker diarization or identification built on these models would need a fresh review.

## 2. Edda v0.2: Apache-2.0, and does CoRal still apply?

From the card:

> The model weights are released under the Apache License 2.0 by the Alexandra Institute, which is also the licensor of the CoRal-v3 dataset. The base model `openai/whisper-large-v3-turbo` is MIT-licensed; the training corpora carry their own licenses — see the respective dataset cards.

Training data, from the card's table:

| Corpus | Share of training steps |
| --- | --- |
| FTSpeech | 43% |
| CoRal-v3 read-aloud | 24% |
| NST | 16% |
| CoRal-v3 conversation | 12% |
| FLEURS | 3% |
| Common Voice 17 | 2% |

**Does Apache-2.0 settle CoRal?** Partly, by interpretation:

- The CoRal license is a grant *from* Alexandra Instituttet *to* licensees. A rights holder is not bound by its own outbound license, so it can release a model trained on its own data under any terms it chooses.
- The contrast is telling: the Alexandra Institute's earlier CoRal models carry `license: openrail` with the restrictions, and Edda carries Apache-2.0. That points to a deliberate choice.
- Two things stop this from being a clean "yes":
  - The card's last clause, "the training corpora carry their own licenses — see the respective dataset cards", can be read as pointing back to CoRal.
  - The CoRal "Licensor" definition also covers "the persons or entities that may have rights in the Licensed Material", meaning the speakers.

  **Recommended: get a one-line written confirmation from the Alexandra Institute** that Edda's Apache-2.0 release is not subject to the CoRal section 3 and 4 pass-through. Without it, the conservative move is to put Edda under the same Model Terms as ekko. That costs little.
- Apache-2.0 does **not** settle FTSpeech, which is licensed by Folketinget, not by the Alexandra Institute. See §5.

**Apache-2.0 §4 duties, for our GGML Mirror:**

- Include a copy of the Apache-2.0 text. The source repo has no LICENSE file, so we add one.
- Mark the converted files as modified: "Converted to GGML by Codictate from danish-foundation-models/edda-v0.2 @ 98ec5ee".
- Retain the attribution notices. There is no upstream NOTICE file, so we write one.

**MIT (Whisper)** requires "Copyright (c) 2022 OpenAI" and the MIT permission notice in all copies or substantial portions (from the [openai/whisper LICENSE](https://github.com/openai/whisper/blob/main/LICENSE)).

## 3. ekko-v1-tiny: NVIDIA Open Model License + CC BY 4.0 + CoRal + FTSpeech

RyeAI's `MODEL_LICENSE.md`:

- "Ekko v1 Tiny is a Derivative Model of `nvidia/parakeet-rnnt-110m-da-dk` and is subject to the NVIDIA Open Model License."
- "RyeAI applies Creative Commons Attribution 4.0 International to the modifications it has the right to license ... This does not replace the NVIDIA agreement."
- On CoRal, "Those restrictions apply in addition to the NVIDIA agreement."
- On FTSpeech, "RyeAI distributes the model with that statement and the linked terms."

The base model was itself trained on CoRal (read aloud), so the CoRal terms reach ekko-v1-tiny twice.

**NVIDIA Open Model License, from the PDF dated October 24, 2025:**

- **Attribution and redistribution, §3.1:** "If you distribute the Model, You must give any other recipients of the Model a copy of this Agreement and include the following attribution notice within a "Notice" text file with such copies: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License"".
- **§3.3:** we may add our own terms for our modifications, "provided Your use, reproduction, and distribution of the Model otherwise complies".
- **Commercial use:** allowed. "Models are commercially usable."
- **Restrictions, §2.1:**
  - Patent and copyright litigation over the Model terminates the license.
  - Bypassing any "Guardrail" ends your rights "without a substantially similar Guardrail appropriate for your use case". Whether parakeet or ekko contain any Guardrail is **unverified**; the card names none.
  - "NVIDIA may update this Agreement ... and You agree to either comply with any updated license or cease Your copying, use, and distribution". **We have to monitor this.**
- **AI ethics, §2.3:** use must be consistent with NVIDIA's [Trustworthy AI terms](https://www.nvidia.com/en-us/agreements/trustworthy-ai/terms/). The fetch tool rendered that page as "Last Modified June 27, 2024", with prohibitions on illegal surveillance, illegal biometric processing, and illegal harassment or deception. The exact wording was not independently verified.
- **Other terms:**
  - §5: no use of NVIDIA trademarks beyond describing the origin.
  - §8: **indemnity**. "You will indemnify and hold harmless NVIDIA from and against any claim by any third party arising out of or related to your use or distribution of the Model, Derivative Models or outputs."
  - §10: Delaware law, with exclusive courts in Santa Clara County, California.
  - §11: export compliance.

**CC BY 4.0 (RyeAI modifications), §3(a)(1):**

- Retain the creator identification, the copyright notice, the license notice, the disclaimer notice, and a URI to the material.
- Indicate any modifications.
- Link the license.

**A tension that RyeAI has to resolve, not us.** CC BY 4.0 §2(a)(5)(B) says "You may not offer or impose any additional or different terms or conditions on ... the Licensed Material if doing so restricts exercise of the Licensed Rights". Yet RyeAI layers the CoRal restrictions on top. For Codictate the safe course is to comply with every layer: the most restrictive terms win.

**Provenance gap.** The card says training included "454.1 hours of quality-gated pseudo-labelled audio" and does not name its source. The listed datasets are NST, FTSpeech, NOTA and CoRal-v3. The terms for that audio are **unverified**. Ask RyeAI.

## 4. ekko-pnc: CC BY 4.0 + CoRal section 4 + FTSpeech

`MODEL_LICENSE.md`:

> Ekko PnC v2 is licensed under Creative Commons Attribution 4.0 International (CC BY 4.0). It is derived from `jonfd/electra-small-nordic`, also licensed under CC BY 4.0. ... Use and redistribution are also subject to the CoRal restrictions in section 4 of `LICENSES/CORAL-LICENSE`, which are incorporated into these model terms.

`NOTICE`:

> Training text included CoRal, FT Speech and NST; CoRal and FT Speech punctuation was restored by GPT-4o (Azure OpenAI).

- **Attribution.** Credit RyeAI (ekko-pnc) and the author of `jonfd/electra-small-nordic` (CC BY 4.0). The electra card names no person or copyright holder, so credit the HF account `jonfd` and link the URL. Both are CC BY 4.0, and both need the license link and a modifications note if we convert anything.
- **GPT-4o labels.** These are a term between OpenAI and RyeAI. Nothing in RyeAI's files passes an OpenAI obligation down to us. We did not check OpenAI's terms; that is out of scope.
- **Wikipedia text** (`wikimedia/wikipedia`, CC BY-SA 3.0 / GFDL) was used for training. Neither RyeAI nor its NOTICE claims that this creates obligations for the model. Whether training on Wikipedia text makes the model a share-alike adaptation is **unsettled and unverified**. Low practical risk; note it only.
- `NST` is CC0-1.0, and RyeAI bundles the CC0 text. No obligation.

## 5. FTSpeech and Folketinget terms

**The FTSpeech statement.** `LICENSES/FTSPEECH-LICENSE.md` in the RyeAI repos is identical to `ftspeech.github.io/LICENSE.md`:

> Any use of FT Speech text and audio data must be in accordance with the following two licenses: [Folketing's open data] and [Folketing TV]. The data released here must always be accompanied by this LICENSE statement and the two Folketing licenses.

**The FTSpeech paper** (arXiv 2005.12368, p.1): "All materials we provide are freely available for research purposes only. The data, license, and terms of use can be found on ftspeech.dk."

The FTSpeech docs page adds: "Since we cannot release audio data in a segmented form due to the restricted licence, we are releasing full-length audio recordings".

**Folketinget TV licence.** The live page returned 403, so this comes from the Wayback snapshot of 2025-09-05, English section, verbatim:

> 3. ... The above rights include the right to make any changes that are technically required in order to exercise the rights in other media and formats, but other than that, you have no rights to make changes, further develop the TV productions of the Danish Parliament or create derivative works. Any rights that are not expressly mentioned above remain with the licensor.
>
> 4. ... every time you disseminate the work to the general public ... it must be accompanied by a copy of this Licence. ... You may not grant sublicences to the work. ... credit, in accordance with good practice ... by stating the name (or, if relevant, the pseudonym) of the original copyright holder and the title of the work to the extent it is practically possible.

The Danish summary on the same page adds:

> Tv-produktioner fra Folketinget må ikke bruges på en måde, så det kan se ud, som om Folketinget godkender, støtter, anbefaler eller markedsfører dig eller dine produkter eller tjenester ... Det er ikke tilladt at anvende Folketingets logo i brugerens produkter eller tjenester.

In English: Folketinget's TV productions may not be used in a way that makes it look as if Folketinget approves, supports, recommends or markets you or your products or services, and Folketinget's logo may not be used in the user's products or services.

**Folketinget open data terms** (Wayback 2025-04-03):

- The terms grant a "verdensomspændende, gratis, ikke-eksklusiv, og i øvrigt ubegrænset brugsret" (a worldwide, free, non-exclusive and otherwise unlimited right of use), including "bruges kommercielt og ikke-kommercielt" (commercial and non-commercial use).
- "Ved brug af Folketingets åbne data skal Folketinget angives som kilde" (when using Folketinget's open data, Folketinget must be named as the source).
- On the transcripts: "Værket må ikke ændres i videre udstrækning, end den tilladte brug kræver, jf. ophavsretslovens § 11" (the work may not be changed more than the permitted use requires, cf. § 11 of the Danish Copyright Act).
- No endorsement and no use of the logo.

**What this means for Codictate (interpretation).**

- Codictate never distributes FT audio or transcripts. The weights are not the TV production. The duty to accompany the work with the licence attaches to disseminating "the work", which we do not do.
- The open question is upstream: is a model trained on FT audio a "derivative work" or a further development of it, which the TV licence forbids? And does "research purposes only" in the FTSpeech paper bind downstream users of the corpus?
- Whether a text-and-data-mining exception in Danish copyright law covers this training was **not researched**. That is a question for counsel.
- This affects Edda (43% of steps), ekko-v1-tiny, ekko-pnc and, through hviske-v5.1, hviske.
- Practical step: copy RyeAI's approach. Ship `FTSPEECH-LICENSE.md` plus both Folketinget licence texts, credit "Folketinget" as source, and never use Folketinget's name or logo in a way that implies endorsement.

## 6. hviske-v5-tiny (already shipped): CoRal and CC BY-NC

- **Lineage.** `hviske-v5-tiny` is "distilled from the syv-transcribe ensemble" and has `base_model: syvai/hviske-v5.3`; its License section says the licence is "inherited from the teacher syvai/hviske-v5.3".
  - `hviske-v5.3` was fine-tuned on "`CoRal-project/coral-v3` — both `read_aloud` ... and `conversation` ... train splits".
  - It started from `hviske-v5.1`, trained on `syvai/danish-asr-unified` with "`voxpopuli`, `ftspeech`, `coral_read_aloud`, `coral_conversation`, `nst_da`, `nota`, `cv17` sources".
  - The tiny model's own card does not list the audio used for distillation, so that part is **unverified**.
  - **Conclusion:** the teacher is CoRal-trained, and CoRal covers material "derived from or based upon" its data. On a plain reading, hviske-v5-tiny is CoRal Adapted Material. It is also FTSpeech-derived through v5.1.
- **A gap in today's Mirror.** The live `emillykkegrann/hviske-v5-tiny-GGUF` README covers CC BY-NC 4.0 only. It has no CoRal license copy, no restrictions notice, and the app shows no Model Terms. `docs/HVISKE_MIRROR.md` and `scripts/mirror-hviske.ts` say nothing about CoRal.
- **CC BY-NC 4.0 and commercial use: a blocker if Codictate is commercial.** The v5.3 card, which the tiny model inherits from, says:

  > Not permitted without a separate commercial license: any use by or for a commercial entity, integration into a commercial product or service, or use to generate revenue (directly or indirectly). Commercial licensing: contact mads@syv.ai.

  `docs/HVISKE_MIRROR.md` and the Mirror README currently state "Codictate is free and open source software with no paid version and no commercial use". The brief for this research calls Codictate a commercial app. If that is the direction, hviske needs a commercial licence from syvai or must be withdrawn before Codictate goes commercial. The current Mirror wording would also become untrue.
- Side note: the `syvai/hviske-v5-tiny` repo now reports `gated: auto`. ADR-0004 records `manual`. Either way, it does not change the licence.

## 7. Common Voice Danish

- The current Danish datasets on Mozilla Data Collective, per the public API, are both `"license": "Creative Commons Zero v1.0 Universal (CC0-1.0)"`:
  - "Common Voice Scripted Speech 27.0 - Danish" (created 2026-09-17)
  - "Common Voice Spontaneous Speech 5.0 - Danish"
- The MDC site's download UI strings include "You agree that you will not re-host or re-share this dataset" and "You agree not to attempt to determine the identity of speakers in the Common Voice dataset". These bind people who download the dataset. Codictate does not.
- The models used **Common Voice 17** from the old HF repo. Its history was replaced in October 2025: "Effective October 2025, Mozilla Common Voice datasets are now exclusively available through Mozilla Data Collective". **CV17's original license could not be re-read from a primary source today (unverified)**; the current Danish releases are CC0.
- CC0 carries no attribution duty. Nothing to ship.

Other training corpora, for completeness:

| Corpus | License | Duty for Codictate |
| --- | --- | --- |
| NST-da | CC0-1.0 | none |
| NOTA | CC0-1.0 | none |
| FLEURS | CC BY 4.0 | courtesy credit only |
| Granary / MOSEL (parakeet base) | CC BY 4.0 | courtesy credit only |

Whether training on a CC BY dataset creates attribution duties for the model is unsettled. None of the model publishers treat it that way.

## Checklist

### NOTICE (repo root, shipped in the app bundle)

Add one block per model, the way S1-mini and TinyLD are handled, with the full texts under `docs/licenses/<model>/` and mapped in `electrobun.config.ts`:

- [ ] **Edda v0.2.**
  - "Edda v0.2 by the Alexandra Institute / Danish Foundation Models, Apache License 2.0. Converted to GGML by Codictate."
  - "Based on openai/whisper-large-v3-turbo, Copyright (c) 2022 OpenAI, MIT License."
  - Ship the Apache-2.0 and MIT texts.
- [ ] **ekko-v1-tiny.**
  - The exact line **"Licensed by NVIDIA Corporation under the NVIDIA Open Model License"**.
  - "Ekko v1 Tiny by RyeAI, derived from nvidia/parakeet-rnnt-110m-da-dk; RyeAI modifications under CC BY 4.0."
  - Reproduce RyeAI's `NOTICE` verbatim.
  - Ship the NVIDIA OML PDF or its text, CC BY 4.0, `CORAL-LICENSE`, and `FTSPEECH-LICENSE.md` with the two Folketinget licence texts.
- [ ] **ekko-pnc.**
  - "Ekko PnC by RyeAI, CC BY 4.0, derived from jonfd/electra-small-nordic (CC BY 4.0)."
  - Reproduce RyeAI's `NOTICE` verbatim.
  - Ship CC BY 4.0, `CORAL-LICENSE`, and the FTSpeech files.
- [ ] **hviske-v5-tiny** (missing today).
  - "hviske-v5-tiny by syv.ai, CC BY-NC 4.0."
  - Add `CORAL-LICENSE` and the FTSpeech notice.
- [ ] A line saying that these CoRal-derived models are subject to the CoRal use restrictions, with a pointer to the license.

### EULA / Terms (new: Codictate has none)

- [ ] A **Model Terms** accepted in the app before downloading any CoRal-derived model: hviske, ekko-v1-tiny, ekko-pnc, and Edda unless the Alexandra Institute confirms otherwise. It must:
  - reproduce CoRal Addition 4(a) and (b) and Attachment A verbatim, or as a clearly enforceable summary that links the full text;
  - require users, and anyone they pass the model to, to comply;
  - state that the models are subject to paragraph 4. This is CoRal §3(a), (b) and §4.
- [ ] Pass through the NVIDIA OML for ekko-v1-tiny. Recipients are bound by the Agreement, including Trustworthy AI, §5 trademarks and §11 export.
- [ ] A no-endorsement clause covering NVIDIA, the Alexandra Institute and Folketinget.
- [ ] Decide how Attachment A 3(a) is handled. See the blocker below.
- [ ] If Codictate becomes commercial: CC BY-NC clears hviske only with a syvai commercial licence.

### Mirror READMEs (Hugging Face model cards Codictate hosts)

- [ ] **Edda GGML Mirror.**
  - `license: apache-2.0`.
  - A LICENSE file with the Apache-2.0 text, plus a NOTICE.
  - A "Modified by Codictate: converted to GGML from danish-foundation-models/edda-v0.2 at revision 98ec5ee" line.
  - The MIT notice for the Whisper base.
  - A link to the original repo, and the training-data list including the FTSpeech statement. Add the CoRal license copy too if we take the conservative route.
- [ ] **ekko-v1-tiny / ekko-pnc, if mirrored.** Mirror only if we cannot download from RyeAI directly; both repos are ungated, so pinned direct downloads are possible.
  - Copy `MODEL_LICENSE.md`, `NOTICE` and `LICENSES/*` unchanged.
  - Keep the NVIDIA Notice line.
  - Add a modified-files notice for any re-quantization. This is required by CoRal §3(c), Apache §4(b) and CC BY §3(a)(1)(B).
  - Downloading straight from RyeAI's pinned revision avoids Codictate becoming a "distributor". Codictate stays a "You" under CoRal either way, as an end-use speech recognizer.
- [ ] **hviske Mirror.**
  - Add `LICENSES/CORAL-LICENSE`, the FTSpeech statement, and a paragraph stating the CoRal restrictions apply.
  - Update `scripts/mirror-hviske.ts` `buildReadme()` and `docs/HVISKE_MIRROR.md` to match.
  - Revisit the "no commercial use" sentence.

### In-app attribution

- [ ] An "Acknowledgements / Licenses" view, or a link to the bundled `licenses/` folder, listing each Danish model, its author, its license and the CoRal / NVIDIA notices.
- [ ] At the point of download, a line under each Danish model: "<Model> by <author>. <License>. Subject to CoRal use restrictions. [View terms]". This doubles as the CoRal §3(a) notice to subsequent users.
- [ ] No use of the NVIDIA, Folketinget, Alexandra Institute or CoRal names or logos to suggest endorsement.

## Blockers

1. **hviske-v5-tiny CC BY-NC 4.0 against commercial use.** This model is already shipped. It is a hard blocker the moment Codictate is commercial, under syvai's own wording on the teacher card. Get a commercial licence (mads@syv.ai) or remove hviske first.
2. **CoRal Attachment A 3(a) ("disclaiming that it is machine-generated")** for every CoRal-derived model: hviske (shipped), ekko-v1-tiny and ekko-pnc, and Edda if CoRal is held to apply. Read literally, it cannot be satisfied for ordinary dictation. Ask the Alexandra Institute for a written clarification. Until then, pass it through verbatim and accept the risk deliberately.
3. **No legal agreement exists to carry the CoRal restrictions.** CoRal §3(a) requires one. This is not a reason not to ship, but the Model Terms acceptance has to be built before ekko-v1-tiny or ekko-pnc ship. hviske already lacks it.

Not blockers, but open risks: FTSpeech and Folketinget TV derivative-work language (§5), the ekko pseudo-label provenance (§3), and the Wikipedia share-alike question (§4).

## Needs manual human verification

- [ ] **Folketinget TV terms, live page.** `https://www.ft.dk/da/aktuelt/tv-fra-folketinget/deling-og-rettigheder` and the open-data page returned **HTTP 403** to every automated fetch. Check in a browser that the text still matches the 2025-09-05 Wayback snapshot quoted above.
- [ ] **ftspeech.dk terms.** The paper points to ftspeech.dk for "the data, license, and terms of use". Only the GitHub Pages mirror was readable.
- [ ] **Alexandra Institute:**
  - (a) Is Edda's Apache-2.0 free of the CoRal pass-through?
  - (b) Does Attachment A 3(a) apply to ASR transcripts of the user's own speech?
- [ ] **RyeAI:** the source and terms of the 454.1 hours of pseudo-labelled audio in ekko-v1-tiny.
- [ ] **syvai:**
  - The exact distillation data for hviske-v5-tiny.
  - The commercial licence, if Codictate is or becomes commercial.
  - Whether the CoRal pass-through wording on the Mirror is acceptable to them.
- [ ] **Codictate's commercial status.** The repo docs say free and non-commercial; the brief for this research says commercial. That status decides blocker 1.
- [ ] **NVIDIA Trustworthy AI terms.** Exact current wording; it was read through a summarising fetch only.
- [ ] **NVIDIA Guardrails.** Confirm that parakeet-rnnt-110m-da-dk and ekko contain none, which matters for §2.1.
- [ ] **Counsel.** Whether training on FT audio or transcripts is permitted under Danish copyright law, given the TV licence's "no derivative works" clause and FTSpeech's "research purposes only". Also whether CC BY 4.0's no-downstream-restrictions clause conflicts with RyeAI layering the CoRal terms on top.
