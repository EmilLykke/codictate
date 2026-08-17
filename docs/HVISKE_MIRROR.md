# Mirroring hviske-v5-tiny

`syvai/hviske-v5-tiny` is the Danish ASR model Codictate wants to offer. Its Hugging
Face repository is `gated: manual`, so the app cannot download the weights on a
user's behalf. The fix is a **Mirror**: a copy Codictate hosts itself.

Run `scripts/mirror-hviske.ts` to create it. **You run that script, not an agent**,
because it needs a Hugging Face write token. Never paste a write token into an agent
conversation.

## Licence position

The model is plain **CC BY-NC 4.0**. The Hugging Face `cardData` carries no
`extra_gated_prompt` and no `extra_gated_fields`, so there is no additional agreement
attached to the gate. CC BY-NC 4.0 permits non-commercial redistribution with
attribution, and Codictate is free with no paid version and no commercial use, so the
mirror fits the licence.

This is not legal advice. syvai gated the repository deliberately, so ask them first
rather than relying on the licence alone. The message to send is below.

## Steps

```bash
# HF_TOKEN needs read access and an approved gate request on the source repo.
export HF_TOKEN=hf_...
# HF_WRITE_TOKEN needs write access to your own destination repo.
export HF_WRITE_TOKEN=hf_...

bun run scripts/mirror-hviske.ts --print-readme   # review the model card
bun run scripts/mirror-hviske.ts --dry-run        # download and stage, upload nothing
bun run scripts/mirror-hviske.ts                  # create the repo and upload
```

Both quantizations are mirrored so the benchmark can settle which should be the
default. The model card lists identical WER (10.51) for the two:

| File | Size | Speed on M4 |
| --- | --- | --- |
| `hviske-v5-tiny-f16.gguf` | 527 MB | ~39x realtime |
| `hviske-v5-tiny-q4_k.gguf` | 160 MB | ~56x realtime |

`f16` is the chosen primary.

## Runtime constraint

These GGUFs load only under crispasr's `cohere` backend (`--backend cohere`).
whisper.cpp and llama.cpp cannot read them, which is one of the reasons crispasr
exists as a second ASR Harness. See `docs/adr/0002-asr-harness-abstraction.md`.

Wiring hviske into the app is deliberately **not** done yet.

## Message to syvai

Send this before mirroring:

> Hej syvai
>
> Jeg har fået adgang til hviske-v5-tiny og har testet GGUF-versionerne via CrispASR.
> Tallene er stærke: q4_k er 160 MB og kører omkring 56x realtid på en M4, f16 er
> 527 MB og kører omkring 39x realtid, og dansk WER ligger omkring 10,5. Flot arbejde.
>
> Jeg udvikler Codictate (https://github.com/EmilLykke/codictate), en gratis open
> source diktat-app til macOS og Windows. Den kører 100% lokalt, uden cloud, uden
> konto og uden analytics. Appen er gratis og kommer ikke til at koste penge. Der
> bliver ingen betalt version og ingen kommerciel udnyttelse.
>
> Jeg vil rigtig gerne tilbyde hviske-v5-tiny som dansk model i appen. Problemet er,
> at jeres repo er gated, så mine brugere ikke kan hente modellen direkte inde fra
> appen. Derfor vil jeg spørge, om det er i orden, at jeg lægger en kopi af
> hviske-v5-tiny-f16.gguf og hviske-v5-tiny-q4_k.gguf op i mit eget offentlige
> Hugging Face-repo, med tydelig kreditering til jer, link tilbage til
> original-repoet, og uændret CC BY-NC 4.0-licens.
>
> Som jeg læser CC BY-NC 4.0, må jeg dele materialet ikke-kommercielt med
> kreditering. Men da I bevidst har sat repoet til manuel godkendelse, vil jeg
> hellere spørge først end bare gøre det.
>
> Sig til, hvis I har ønsker til, hvordan krediteringen skal formuleres, eller hvis I
> foretrækker en anden løsning.
>
> Mvh
> Emil Lykke Grann
