#!/usr/bin/env python3
"""
Generates the ekko-pnc parity fixture: what the Python reference makes of a fixed set of
texts, for the Punctuation Restorer's parity test to match byte for byte.

The reference is `Punctuator.__call__` from `ekko-stt[pnc]==0.1.2`, run on the weights at
the pinned upstream revision with `onnxruntime==1.30.0`, the version the app ships
(`onnxruntime-node` 1.30.0), so both sides run the same int8 kernels. The wheel's `pnc`
extra pins onnxruntime 1.29.0, so install the packages by hand instead of through the extra:

    python3.12 -m venv /tmp/pnc-venv   # must be Python 3.12.2, the titlecase table's Python
    /tmp/pnc-venv/bin/pip install ekko-stt==0.1.2 onnxruntime==1.30.0 tokenizers==0.22.2
    /tmp/pnc-venv/bin/python -I scripts/generate-pnc-parity-fixture.py <ekko-pnc folder>

The folder holds `pnc.int8.onnx`, `tokenizer.json` and `config.json` from `RyeAI/ekko-pnc`
at revision d3129544e4e0155093e192cac58a9e69a4dea1ff; they are checked against their sha256.

Writes src/bun/utils/punctuation/fixtures/ekko-pnc-parity.json. Each case holds the input,
the full pretokenized encoding the reference computes first (`ids`, `wordIds`), and the
reference's output. The Python version is pinned because its Unicode database decides
`isalpha`, `isupper` and `title`; moving it means re-running
scripts/generate-titlecase-table.py with the same Python and committing both outputs.
"""

import hashlib
import json
import sys
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = ROOT / "src/bun/utils/punctuation/fixtures/ekko-pnc-parity.json"

PYTHON = (3, 12, 2)
PACKAGES = {"ekko-stt": "0.1.2", "onnxruntime": "1.30.0", "tokenizers": "0.22.2"}
SOURCE_REVISION = "d3129544e4e0155093e192cac58a9e69a4dea1ff"
MODEL_FILES = {
    "pnc.int8.onnx": "46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527",
    "tokenizer.json": "a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502",
    "config.json": "dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca",
}

# Lowercase, unpunctuated Danish, the way a Speech Engine without punctuation writes it.
# Most are over 128 tokens, so they run in more than one window.
PASSAGES = {
    "morning": (
        "i morges stod jeg op klokken seks fordi hunden ville ud og så gik vi en lang tur "
        "ned til havnen hvor der allerede var mange mennesker der løb eller cyklede på "
        "arbejde bagefter lavede jeg kaffe og læste avisen på telefonen mens børnene spiste "
        "morgenmad min datter skulle have idræt i dag men hun havde glemt sine sko igen og "
        "vi måtte lede efter dem i hele huset til sidst fandt vi dem under sofaen og så kom "
        "vi alligevel for sent i skole men læreren sagde at det var helt i orden så længe "
        "det ikke skete hver dag jeg tror egentlig at hun var mere ked af det end jeg var"
    ),
    "holiday": (
        "sidste sommer tog vi på ferie til bornholm med færgen fra ystad og det var første "
        "gang børnene havde været der vi havde lejet et lille sommerhus tæt på gudhjem med "
        "udsigt over vandet og hver morgen kunne man se solen stå op over klipperne den "
        "første dag cyklede vi rundt på øen men det var meget mere kuperet end vi havde "
        "regnet med så efter en halv time måtte vi skubbe cyklerne op ad bakkerne min søn "
        "klagede hele vejen men han blev glad igen da vi fandt en isbod nede ved havnen om "
        "eftermiddagen badede vi ved dueodde hvor sandet er så fint at det næsten føles som "
        "mel og vandet var overraskende varmt til at være i juli om aftenen grillede vi "
        "pølser og spillede kort indtil det blev mørkt dagen efter regnede det hele dagen så "
        "vi kørte til rønne og besøgte et museum om øens historie under krigen det var "
        "faktisk ret spændende også for børnene fordi der var mange gamle ting man måtte "
        "røre ved bagefter spiste vi røget sild med rå æggeblomme som man jo skal når man er "
        "på bornholm min mand syntes det var lækkert men børnene ville hellere have pommes "
        "frites resten af ugen var vejret heldigvis godt og vi nåede både at se hammershus og "
        "at sejle ud til ertholmene hvor der bor færre end hundrede mennesker hele året da vi "
        "skulle hjem var alle enige om at vi skulle tilbage igen næste år og måske blive lidt "
        "længere"
    ),
    "meeting": (
        "okay så skal vi lige have styr på dagsordenen til mødet på torsdag først skal vi "
        "gennemgå budgettet for næste kvartal og der skal vi især se på udgifterne til rejser "
        "som er steget med næsten tyve procent siden sidste år derefter vil jeg gerne have at "
        "mette fortæller om status på det nye kundesystem fordi der har været en del problemer "
        "med at logge ind efter opdateringen vi har fået mange henvendelser fra kunder der "
        "ikke kan finde deres fakturaer og det skal vi have løst hurtigst muligt så vil jeg "
        "også foreslå at vi diskuterer om vi skal ansætte en ekstra udvikler eller om vi kan "
        "klare os med en konsulent i en periode personligt hælder jeg mest til at ansætte "
        "nogen fast men jeg er åben over for andre forslag til sidst skal vi aftale hvornår vi "
        "holder julefrokost og hvem der står for at bestille mad husk at sende jeres "
        "kommentarer til mig senest onsdag klokken tolv så jeg kan nå at samle dem inden mødet"
    ),
    "recipe": (
        "til fire personer skal du bruge et halvt kilo hakket oksekød to løg tre fed "
        "hvidløg en dåse hakkede tomater og en halv liter bouillon start med at hakke løgene "
        "fint og svits dem i lidt olie i en stor gryde indtil de er bløde og gyldne tilsæt "
        "hvidløget og lad det stege et minut mere uden at det bliver brændt derefter kommer "
        "du kødet i og brun det godt mens du rører rundt med en grydeske når kødet er brunet "
        "tilsætter du tomaterne og bouillonen og lader det hele simre under låg i mindst en "
        "halv time smag til med salt peber og lidt oregano hvis du har det imens kan du koge "
        "pastaen i rigeligt vand med salt den skal koge i cirka ti minutter men tjek altid "
        "hvad der står på pakken server retten med revet parmesan og en grøn salat ved siden "
        "af hvis der er rester kan de sagtens fryses og spises en anden dag"
    ),
    "weather": (
        "ifølge danmarks meteorologiske institut bliver weekenden blæsende med kraftige byger "
        "især i den vestlige del af jylland hvor der kan komme op til tredive millimeter regn "
        "på et døgn temperaturen ligger mellem otte og tolv grader og om natten kan der "
        "enkelte steder blive frost i indlandet vejdirektoratet opfordrer bilister til at "
        "køre forsigtigt og holde ekstra afstand på motorvejene samtidig melder dsb om "
        "forsinkelser på strækningen mellem odense og aarhus på grund af en signalfejl ved "
        "fredericia passagerer bedes holde øje med trafikinformationen inden de tager "
        "hjemmefra næste uge ventes vejret at blive mere stabilt med sol og svag vind fra syd "
        "og temperaturer omkring femten grader om eftermiddagen"
    ),
    "email": (
        "hej allesammen tak for i går det var rigtig hyggeligt at se jer alle sammen igen "
        "efter så lang tid jeg har lagt billederne op i den fælles mappe så i kan hente dem "
        "hvis i har lyst og husk at vi har talt om at mødes igen til foråret måske i påsken "
        "hvis det passer de fleste jeg sender et forslag til datoer i næste uge og så må i "
        "svare hurtigt så vi kan nå at booke et sted skriv endelig hvis der er nogen der har "
        "spørgsmål eller hvis jeg har glemt nogen på listen de bedste hilsner fra peter"
    ),
    "doctor": (
        "jeg ringede til lægen i morges fordi min hoste ikke er blevet bedre efter to uger "
        "sekretæren sagde at jeg kunne komme ind på fredag klokken halv ni og at jeg skulle "
        "huske mit sundhedskort hun spurgte også om jeg havde feber eller ondt i brystet men "
        "det har jeg heldigvis ikke indtil da skal jeg bare drikke meget vand og hvile mig så "
        "meget som muligt hvis det bliver værre i weekenden skal jeg ringe til vagtlægen på "
        "telefonnummeret der står på hjemmesiden"
    ),
}

# What the spec says the reference makes of text a Speech Engine already punctuated, fed to
# it as is. The generator checks the reference still gives exactly this.
DOUBLES = {
    "Hej med dig, hvordan går det, jeg håber du har det godt.": (
        "Hej med dig,, hvordan går det,? Jeg håber, du har det godt."
    ),
    "Der er 3,5 mio. mennesker i f.eks. København.": (
        "Der er 3,5 mio. Mennesker i f.eks.. København."
    ),
}

EDGE_CASES = {
    "one lowercase word": "hej",
    "already capitalised words": "jeg har købt en ny iPhone på eBay og læst om NATO i avisen",
    "capitalised words first": "NATO holder møde i dag og iPhone sælger godt og eBay også",
    "mixed case": "Jeg Skriver Nogle Gange Med Store Bogstaver og NOGLE GANGE slet ikke",
    "ligature first": "ﬁnt",
    "ligatures": "det var ﬂot og ﬁnt og eﬀektivt",
    "full stop before iPhone": "det er min nye telefon . iPhone er nemlig den bedste",
    "word ending in a full stop before iPhone": "det er min nye telefon. iPhone er bedst",
    "DR mid-sentence": "jeg så nyhederne på DR i aftes sammen med min far",
    "sharp s first": "ßtraße er et tysk ord",
    "sharp s after a sentence end": "det er tysk. ßtraße betyder vej",
    "dz digraph first": "ǆungla er et ord",
    "dz digraph after a sentence end": "se her. ǆungla er et ord",
    "half and euro": "prisen er ½ € per stk og det er billigt",
    "thousands with a full stop": "der kom 1.500 mennesker til koncerten i går",
    "CJK": "han sagde 你好 og 世界 til mig",
    "CJK inside a word": "ordet abc你好def er mærkeligt",
    "CJK outside the BMP": "tegnet 𠀀 og 𠀀𠀁 og x𠀀y er sjældne",
    "zero-width space word": "hej ​ med dig",
    "only zero-width spaces": "​ ​",
    "Python whitespace": "hej\tmed dig　og\x1cdig igen\n",
    "one word over 128 tokens": "han sagde " + ",".join(["ja"] * 80) + " og gik",
    "words with no letters": "123 456 ½ ... !!",
    "empty": "",
    "whitespace only": " \n\t ",
}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <ekko-pnc folder>")
    if sys.version_info[:3] != PYTHON:
        sys.exit(
            "needs Python %d.%d.%d (the titlecase table's), got %d.%d.%d"
            % (PYTHON + tuple(sys.version_info[:3]))
        )
    for package, pinned in PACKAGES.items():
        installed = version(package)
        if installed != pinned:
            sys.exit(f"needs {package}=={pinned}, got {installed}")
    model_dir = Path(sys.argv[1])
    for name, pinned in MODEL_FILES.items():
        actual = sha256_of(model_dir / name)
        if actual != pinned:
            sys.exit(f"{name}: sha256 {actual}, expected {pinned}")

    from ekko.pnc import Punctuator

    punctuator = Punctuator(model_dir)

    def case(name: str, text: str) -> dict:
        words = text.split()
        encoding = punctuator.tokenizer.encode(list(words), is_pretokenized=True)
        return {
            "name": name,
            "input": text,
            "ids": encoding.ids,
            "wordIds": encoding.word_ids,
            "output": punctuator(text),
        }

    cases = [case(name, text) for name, text in PASSAGES.items()]
    cases += [case(name, text) for name, text in EDGE_CASES.items()]
    for text, expected in DOUBLES.items():
        double = case(f"already punctuated: {text}", text)
        if double["output"] != expected:
            sys.exit(f"reference gave {double['output']!r} for {text!r}, spec says {expected!r}")
        cases.append(double)

    long_passages = [c["name"] for c in cases[: len(PASSAGES)] if len(c["ids"]) > 128]
    assert len(long_passages) >= 3, f"only {long_passages} are over 128 tokens"

    fixture = {
        "generatedBy": "scripts/generate-pnc-parity-fixture.py",
        "python": "%d.%d.%d" % sys.version_info[:3],
        "packages": {package: version(package) for package in [*PACKAGES, "numpy"]},
        "sourceRevision": SOURCE_REVISION,
        "modelFiles": MODEL_FILES,
        "passageWords": sum(len(text.split()) for text in PASSAGES.values()),
        "cases": cases,
    }
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{len(cases)} cases, {fixture['passageWords']} passage words -> {FIXTURE_PATH}")


if __name__ == "__main__":
    main()
