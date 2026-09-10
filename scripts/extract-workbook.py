#!/usr/bin/env python3
"""Extract the shop's Excel estimator into machine-readable seed files.

Reads `docs/reference/Quote_Metal_Cost.xls` (BIFF8, read-only) and writes:

    packages/db/seed/*.json                        catalog + shop defaults
    packages/calc/test/fixtures/golden-workbook.json   the REQUIREMENTS §9 fixture

Values only -- xlrd reads the cached results the workbook last saved. That is
deliberate: every number the seed and the fixture need is a value, and the
machine's Office policy blocks opening .xls through Excel automation, so
formulas are not available. Where a constant lives only inside a formula
(the 12-inch minimum strip), it is recovered by solving the arithmetic from
values that ARE present, and tagged `"source": "derived"` so the provenance
is never mistaken for a cell read.

What is emitted is deliberately narrower than what is read. The workbook is a
record of how this shop thinks about cost, seed data the owner overwrites, and
a validation oracle for the REQUIREMENTS §9 selling prices -- it is not a
specification to mirror. So spreadsheet residue is read where it helps the
extraction and then dropped: index numbers, source rows, helper columns, and
the columns that hold whatever quote happened to be loaded when the file was
last saved. See docs/course-correction.md.

BUILD-PLAN Task 0.2. Run from the repo root:  python scripts/extract-workbook.py
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

try:
    import xlrd
except ImportError:  # pragma: no cover
    sys.exit("xlrd is required:  python -m pip install xlrd")

ROOT = Path(__file__).resolve().parent.parent
XLS = ROOT / "docs" / "reference" / "Quote_Metal_Cost.xls"
SEED_DIR = ROOT / "packages" / "db" / "seed"
FIXTURE_DIR = ROOT / "packages" / "calc" / "test" / "fixtures"
DISCOVERY = ROOT / "docs" / "discovery.md"

SHEET = "PART COST WORKSHEET"
LASER_SHEET = "LASER WORKSHEET"
ASSY_SHEET = "Assy-Handling Cost Estimator"

# --------------------------------------------------------------------------
# Cell map. Rows are 1-indexed as Excel shows them; columns are letters.
#
# Verified against the workbook on 2026-09-09. Several ranges differ from the
# ones quoted in BUILD-PLAN Task 0.2 -- the header row was being counted as
# data. The ranges below are the observed ones.
# --------------------------------------------------------------------------
MATERIALS_ROWS = (124, 210)   # BUILD-PLAN said 123-210; 123 is the header
OPERATIONS_ROWS = (32, 51)    # header 31
PLATING_ROWS = (74, 116)      # BUILD-PLAN said 72-115; header is 73, data ends 116
SILKSCREEN_ROWS = (215, 221)  # BUILD-PLAN said 213-220; header is 214
PUNCH_ROWS = (32, 43)         # tool name in P, hit rate in V
COATING_ROWS = (52, 67)
PRESET_ROWS = (282, 283)      # BUILD-PLAN said 281-282; 281 is the header
BLANK_TABLE_ROWS = (233, 280)

# Operations whose hours come from a cutting worksheet (§5.2/§5.3) rather than
# from a parts-per-hour standard: one laser and two turret punches. The
# workbook has no such column -- it encodes the distinction as `std = 100`
# scaffolding for its ×K/std formula -- so the split is assigned here and
# recorded in docs/decisions.md. Everything else is a manual operation priced
# as countPerPart / standardPerHr.
MACHINE_OPS = {"laser", "pega-50-x-72", "em2510nt-60-x-98"}

# REQUIREMENTS §3 gives every operation a `standardUnit`, so the UI can label
# the count ("bends" vs "inches of weld") and calc can validate it. The
# workbook has no such column -- its standards are bare numbers -- so the two
# linear operations are named here and everything else counts pieces.
INCH_STANDARD_OPS = {"weld", "grind"}

unresolved: list[dict] = []


def note(table: str, cell: str, what: str, why: str) -> None:
    unresolved.append({"table": table, "cell": cell, "field": what, "why": why})


# --------------------------------------------------------------------------
# Cell access
# --------------------------------------------------------------------------
def col(letter: str) -> int:
    n = 0
    for ch in letter.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


class Sheet:
    def __init__(self, book, name: str):
        self.sh = book.sheet_by_name(name)
        self.name = name

    def raw(self, row: int, letter: str):
        r, c = row - 1, col(letter)
        if r >= self.sh.nrows or c >= self.sh.ncols:
            return ""
        return self.sh.cell_value(r, c)

    def text(self, row: int, letter: str) -> str | None:
        v = self.raw(row, letter)
        if v is None or v == "":
            return None
        return str(v).strip() or None

    def num(self, row: int, letter: str) -> float | None:
        v = self.raw(row, letter)
        if isinstance(v, bool) or v is None or v == "":
            return None
        if isinstance(v, (int, float)):
            return float(v)
        try:
            return float(str(v).strip())
        except ValueError:
            return None


# --------------------------------------------------------------------------
# Material name parsing.
#
# The workbook has no thickness column and no family column, yet REQUIREMENTS
# §3 wants both. Both are recoverable from the name only; anything not matched
# is left null and listed in docs/discovery.md rather than guessed.
# --------------------------------------------------------------------------
THICKNESS_PATTERNS = [
    re.compile(r"\((\.\d+)\)"),                  # G30 16 GA (.0598)
    re.compile(r"(\d+/\d+)\s*\"")   ,            # 3/4" PLYWOOD
    re.compile(r"(\.\d+)\s*\"?\s*THK", re.I),    # ALUM .020" THK
    re.compile(r"\s(\.\d+)\s*\""),               # HRPO PLATE .25"
    re.compile(r"\s(\.\d{3,4})\b"),              # COPPER .032
]

# Order matters: "CRS GAL HOT DIP" is galvanised, not plain steel, so the
# galv markers are tested before the CRS marker.
FAMILY_RULES = [
    ("galv", ("GAL HOT DIP", "GALVANNEAL", "EZC", "G30", "G90")),
    ("stainless", ("ST STL", "STAINLESS", "304", "316")),
    ("aluminum", ("ALUM", "5052", "6061")),
    ("copper", ("COPPER",)),
    ("brass", ("BRASS",)),
    ("wood", ("PLYWOOD", "MDF", "LAMINATE", "PARTICLE")),
    ("steel", ("CRS", "HRPO", "HRS", "PLATE")),
]


def parse_thickness(name: str) -> float | None:
    for pat in THICKNESS_PATTERNS:
        m = pat.search(name)
        if not m:
            continue
        tok = m.group(1)
        if "/" in tok:
            num, den = tok.split("/")
            return round(float(num) / float(den), 6)
        return float(tok)
    return None


def parse_family(name: str) -> str:
    up = name.upper()
    for family, markers in FAMILY_RULES:
        if any(mk in up for mk in markers):
            return family
    return "other"


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "unnamed"


# --------------------------------------------------------------------------
# Extractors
# --------------------------------------------------------------------------
def extract_materials(pcw: Sheet) -> list[dict]:
    """Materials catalog.

    Columns: C name, H optics, I/J cutting speed max/min (m/min), K average
    (m/min), L average (in/min), P pierce seconds, Q lb/ft^2, R $/lb,
    S blank length, T punch rate factor, U sheet cost, V sheet lbs, W $/lb.

    L is taken verbatim and never recomputed from K. For most rows
    L == K * 39.37, but G30 16 GA carries an overriding 220 in/min against a
    6.8 m/min average (= 267.7), and 220 is the figure REQUIREMENTS §9 prices
    the golden part with.

    U (cost per sheet) and V (lbs per sheet) are price provenance only where
    U/V reproduces R -- elsewhere in the table those two columns hold
    unrelated scratch values (row 145 puts thickness and steel density there),
    so they are accepted only when the arithmetic checks out.

    Read but not emitted: B (the workbook's index number -- rows are addressed
    by key), H (laser lens size, a machine attribute filed under material),
    and I/J/K (the metric speeds L was derived from). Keeping a derivation's
    inputs beside its output invites the two to disagree the first time an
    owner edits a speed in Settings; L is the number the engine uses.
    """
    rows = []
    lo, hi = MATERIALS_ROWS
    for r in range(lo, hi + 1):
        name = pcw.text(r, "C")
        if not name:
            continue  # spacer rows and the U/V/W mini-headers at 167/202/211

        price_per_lb = pcw.num(r, "R")
        sheet_cost, sheet_lbs = pcw.num(r, "U"), pcw.num(r, "V")
        if (
            sheet_cost is None
            or sheet_lbs in (None, 0)
            or price_per_lb is None
            or abs(sheet_cost / sheet_lbs - price_per_lb) > 1e-4
        ):
            sheet_cost = sheet_lbs = None

        thickness = parse_thickness(name)
        if thickness is None:
            note("materials", f"C{r}", "thickness_in",
                 f"no thickness in name {name!r}; workbook has no thickness column")

        rows.append({
            "key": slug(name),
            "name": name,
            "family": parse_family(name),
            "thickness_in": thickness,
            "lb_per_sq_ft": pcw.num(r, "Q"),
            "price_per_lb": price_per_lb,
            "std_length_in": pcw.num(r, "S"),
            "speed_in_min": pcw.num(r, "L"),
            "pierce_s": pcw.num(r, "P"),
            "punch_rate_factor": pcw.num(r, "T"),
            "sheet_cost": sheet_cost,
            "sheet_lbs": sheet_lbs,
            "active": True,
        })
    return rows


def extract_operations(pcw: Sheet) -> list[dict]:
    """Operations catalog.

    Catalog columns are D (setup hrs), F (standard) and H (rate). Columns
    E/G/I/J/K/L belong to whatever quote is loaded in the sheet -- right now
    that is the golden part -- so they are NOT seed data and are skipped.

    F (the workbook's "standard") is emitted as `standard_per_hr` for manual
    operations, where it is a real rate -- 222 bends/hr, 200 in/hr of weld. For
    the machine operations in MACHINE_OPS it is scaffolding that exists so the
    ×K/std formula resolves (laser 100, Pega 0), so it is emitted as null and
    their hours come from the cutting worksheet instead.

    The ×60 rule of REQUIREMENTS §5.4 (quirk Q2) is NOT emitted per row. It was
    recovered here as K = G * F / E = 60 on the laser row, but 60/100 is a
    property of the pricing rule, not of any operation: it survives as the
    single `parity.machineTimeFactor` of 0.6. See docs/course-correction.md §2.3.
    """
    rows, seen, dropped_std = [], {}, []
    lo, hi = OPERATIONS_ROWS
    for r in range(lo, hi + 1):
        name = pcw.text(r, "C")
        if not name:
            continue

        std = pcw.num(r, "F")

        # BRAKE, BEND appears twice (222/hr and 330/hr). Keep both, but make
        # the key unique so downstream tables can address them.
        key = slug(name)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:
            key = f"{key}-{int(std) if std else seen[key]}"

        machine = key in MACHINE_OPS
        if machine and std:
            dropped_std.append(f"{name} (F{r} = {std:g})")

        rows.append({
            "key": key,
            "name": name,
            "kind": "machine" if machine else "manual",
            "setup_hrs": pcw.num(r, "D"),
            "standard_per_hr": None if machine else std,
            "standard_unit": None if machine
                             else ("inches" if key in INCH_STANDARD_OPS else "pieces"),
            "rate_per_hr": pcw.num(r, "H"),
            "active": True,
        })

    missing = sorted(MACHINE_OPS - {row["key"] for row in rows})
    assert not missing, f"MACHINE_OPS names no such operation: {missing}"

    note("operations", f"F{OPERATIONS_ROWS[0]}-{OPERATIONS_ROWS[1]}", "standard_unit",
         "the workbook records standards as bare numbers with no unit. WELD and "
         "GRIND are seeded as `inches` (both carry 200 in column F, and "
         "REQUIREMENTS §6 notes 120 in/hr for each -- which of the two the 200 "
         "is has to come from the estimator); every other manual row is "
         "`pieces`. Confirm with §10 q1.")

    note("operations", f"F{OPERATIONS_ROWS[0]}-{OPERATIONS_ROWS[1]}", "kind",
         "machine-vs-manual is not a column in the workbook; it is asserted by "
         "the extractor (MACHINE_OPS = laser, Pega, EM2510NT) and needs an "
         "owner confirmation alongside REQUIREMENTS §10 q1. EM2510NT and 30-30 "
         "are the uncertain two: EM2510NT is treated as a turret punch, 30-30 "
         "as a manual operation on its 250/hr standard.")
    if dropped_std:
        note("operations", f"F{OPERATIONS_ROWS[0]}-{OPERATIONS_ROWS[1]}",
             "standard_per_hr",
             "dropped as machine-op scaffolding (hours come from the cutting "
             "worksheet, not a per-hour standard): " + ", ".join(dropped_std))
    return rows


def extract_plating(pcw: Sheet) -> list[dict]:
    rows = []
    lo, hi = PLATING_ROWS
    for r in range(lo, hi + 1):
        spec = pcw.text(r, "C")
        if not spec:
            continue  # numbered-but-blank rows (81, 84, 86, 91, 96, 100, 102, 115)
        rows.append({
            "key": slug(spec),
            "spec": spec,
            "lot_min_charge": pcw.num(r, "I"),
            "price_per_sq_in": pcw.num(r, "J"),
            "part_min": pcw.num(r, "K"),
            "active": True,
        })
    return rows


def extract_silkscreen(pcw: Sheet) -> list[dict]:
    rows = []
    lo, hi = SILKSCREEN_ROWS
    for r in range(lo, hi + 1):
        spec = pcw.text(r, "C")
        if not spec:
            continue
        screen = pcw.num(r, "F")
        if screen is None and spec.upper().endswith("CUSTOMER"):
            note("silkscreen", f"F{r}", "screen_cost",
                 f"{spec}: screen cost blank (customer-supplied screen)")
        rows.append({
            "key": slug(spec),
            "spec": spec,
            "screen_cost": screen,
            "print_cost": pcw.num(r, "G"),
            "active": True,
        })
    return rows


def extract_coating(pcw: Sheet) -> dict:
    """Powder/paint estimator (REQUIREMENTS §5.5, quirk Q3).

    The column headers on row 51 do not describe what the cells do: U is
    labelled "# Sides" but behaves as a $ rate, and S is unlabelled. The
    observed arithmetic for Coating A is

        cost = U * (V / T * S) = 0.5 * (42.476 / 100 * 5) = 1.0619

    where V is the part perimeter, not an area. The three constants are carried
    through verbatim but nested under `legacy`, so nothing mistakes them for
    physics: they are quirk Q3's parameters and naming them correctly is
    blocked on REQUIREMENTS §10 question 2. The §11.3 `modern` model has no
    source in the workbook and is left for Settings.

    Columns V/W/X hold the loaded quote's own coating cost (1.0619 for the §9
    part), not seed data, and are not emitted.
    """
    models = []
    for r in (52, 54, 56):
        name = pcw.text(r, "P")
        if not name:
            continue
        models.append({
            "key": slug(name),
            "name": name,
            "legacy": {
                "s_constant": pcw.num(r, "S"),
                "coverage": pcw.num(r, "T"),
                "rate": pcw.num(r, "U"),
            },
            "modern": None,
        })
    note("coating", "S52/T52/U52", "s_constant/coverage/rate",
         "constants 5 / 100 / 0.5 are unexplained and column U is mislabelled "
         "'# Sides' while acting as a rate; REQUIREMENTS §10 q2")

    note("coating", "(none)", "minimum_charge_usd",
         "CoatingModel.minimumChargeUsd has no source: W67 holds the loaded "
         "quote's own cost (1.0619), not a floor. Left unset until the owner "
         "gives a real minimum, alongside REQUIREMENTS §10 q2.")

    adders = {}
    for r in range(58, 65):
        label = pcw.text(r, "P")
        if label:
            adders[slug(label)] = {"label": label, "rate": pcw.num(r, "U")}

    return {
        "models": models,
        "adders": adders,
        "liquid_texture_adder_pct": 0.5,  # REQUIREMENTS §5.5; not a cell
    }


def extract_punch_rates(pcw: Sheet) -> dict:
    tools = []
    lo, hi = PUNCH_ROWS
    for r in range(lo, hi + 1):
        name = pcw.text(r, "P")
        if not name or name.upper().startswith(("SHEETS FOR", "LOAD", "HIT DENSITY")):
            continue
        # "TOTAL HIT COUNT" sits between TAP and Relief with a 6000/hr rate: a
        # spreadsheet subtotal row, not a tool. REQUIREMENTS §5.3 lists it
        # among the rates, which is the same transcription error one level up.
        if name.upper().startswith("TOTAL HIT"):
            continue
        tools.append({
            "key": slug(name),
            "name": name,
            "multiplier": pcw.num(r, "U"),
            "hit_rate_per_hr": pcw.num(r, "V"),
        })
    return {
        "tools": tools,
        "load_unload_s_per_blank": pcw.num(45, "S"),
    }


def extract_blank_multiples(pcw: Sheet) -> dict:
    """The standard blank lengths a shop can buy, and the stock widths.

    This is the *list* -- the 48-row precomputed yield grid beside it is Excel
    working out `parts_per_blank` for every combination, which the engine does
    on demand. K also carries each width's clamp-subtracted twin (35/36, 47/48,
    59/60); clamp subtraction is one line of arithmetic, so only the nominal
    widths are emitted.
    """
    lo, hi = BLANK_TABLE_ROWS
    mults, widths = set(), set()
    for r in range(lo, hi + 1):
        m = pcw.num(r, "L")
        if m:
            mults.add(m)
        w = pcw.num(r, "K")
        if w:
            widths.add(w)
    # K holds both the nominal width and its clamp-subtracted twin (36/35,
    # 48/47, 60/59). The nominal widths are the larger of each adjacent pair.
    nominal = sorted(w for w in widths if (w + 1) not in widths)
    return {
        "standard_blank_lengths_in": sorted(mults),
        "sheet_widths_in": nominal,
    }


PRESET_NAMES = {"LASER": "Laser", "PUNCH": "Punch"}


def extract_process_presets(pcw: Sheet) -> list[dict]:
    """Clamp and kerf per cutting process.

    The workbook's labels restate the clamp in the name -- "LASER, 1\" CLAMP
    DIM" beside `clamp_in: 1.0` -- which goes stale the moment an owner edits
    the number. The label is reduced to the process; Z (dropdown position) is
    read only to order the rows.
    """
    rows = []
    lo, hi = PRESET_ROWS
    for r in range(lo, hi + 1):
        label = pcw.text(r, "AA")
        if not label:
            continue
        head = label.split(",")[0].strip().upper()
        name = PRESET_NAMES.get(head)
        if name is None:
            name = head.title()
            note("process_presets", f"AA{r}", "name",
                 f"unrecognised process label {label!r}; using {name!r}")
        rows.append({
            "key": slug(name),
            "name": name,
            "clamp_in": pcw.num(r, "AB"),
            "kerf_in": pcw.num(r, "AC"),
        })
    return rows


def extract_assembly(assy: Sheet) -> list[dict]:
    """Seconds per action. Column B is the standard time; C is the count for
    whatever assembly was last estimated, so C and D are quote data and are
    skipped. Section headers (a label with no standard) become `section`."""
    rows, section = [], None
    for r in range(3, assy.sh.nrows + 1):
        label = assy.text(r, "A")
        if not label:
            continue
        std = assy.num(r, "B")
        if std is None:
            section = label
            continue
        rows.append({
            "row": r,
            "section": section,
            "key": slug(label),
            "action": label,
            "std_seconds": std,
        })
    return rows


def extract_shop_defaults(pcw: Sheet) -> dict:
    """Shop-wide defaults. The 12-inch minimum strip of REQUIREMENTS §5.1 is
    not in any cell -- it appears only inside the min-charge formula, which is
    unreadable without formula access. It is recovered by solving

        min_charge = (sheet_width * strip / 144) * lb_ft2 * price_per_lb

    against W7 (8.60448), V7 (48), Q170 (2.656) and R170 (0.809909), and is
    tagged as derived.
    """
    breaks = [pcw.num(12, c) for c in ("E", "F", "G", "H", "I", "J")]

    min_charge, width = pcw.num(7, "W"), pcw.num(7, "V")
    lb_ft2, ppl = pcw.num(170, "Q"), pcw.num(170, "R")
    strip = None
    if all(v for v in (min_charge, width, lb_ft2, ppl)):
        strip = round(min_charge * 144.0 / (width * lb_ft2 * ppl), 6)
    if strip is None or abs(strip - round(strip)) > 1e-6:
        note("shop_defaults", "(formula)", "min_charge_strip_in",
             "12-inch strip is embedded in the min-charge formula; Office File "
             "Block prevents reading formulas, so it was solved arithmetically")
    else:
        strip = int(round(strip))

    # D13 ($20) is NOT a shop default: it equals the sum of the per-operation
    # fixed-dollar column, and the laser's only setup (0.2 h x $100) accounts
    # for all of it. Seeding it as a flat $20 would double-count against
    # REQUIREMENTS §5.6's setup roll-up and miss every §9 price. The flat
    # per-job adder is a real (optional) setting, so it is emitted at zero.
    setup_dollars = 0.2 * 100.0
    if abs((pcw.num(13, "D") or 0) - setup_dollars) > 1e-6:
        note("shop_defaults", "D13", "shop_fixed_cost_per_job",
             f"D13 = {pcw.num(13, 'D')} no longer equals the setup roll-up "
             f"({setup_dollars}); the assumption that D13 is a sum rather than "
             f"a typed-in constant needs rechecking against REQUIREMENTS §5.6")

    return {
        "shop_fixed_cost_per_job": 0.0,
        "labor_markup": pcw.num(10, "C"),
        "material_markup": pcw.num(10, "D"),
        "nre_rate_per_hr": pcw.num(24, "E"),
        "nre_markup": pcw.num(24, "K"),
        # Solved, not read (see the docstring) -- but the provenance belongs in
        # the extractor and docs/decisions.md, not in a config value the owner
        # edits in Settings.
        "min_charge_strip_in": strip,
        "default_qty_breaks": [int(b) for b in breaks if b],
        "sheet_widths_in": [36, 48, 60],
    }


def extract_golden(pcw: Sheet, laser: Sheet) -> dict:
    """The REQUIREMENTS §9 fixture, read from cached values.

    The oracle is deliberately small: the six selling prices, the six material
    percentages, and five named intermediates. Everything else here is an
    *input* -- what the engine needs to reproduce the case. The workbook's own
    intermediate columns (hours per 100, parts per sheet, sheets to make 100,
    the cost-stack rows) are not emitted, because a test that pins them is
    testing Excel's arithmetic rather than ours. See docs/course-correction.md
    §1.2 for the row-by-row audit.

    Blank cost is the one intermediate no cell holds: §9 quotes 68.83, so it is
    reconstructed from the sheet geometry.
    """
    width, blank_len = pcw.num(7, "V"), pcw.num(5, "T")
    lb_ft2, ppl = pcw.num(170, "Q"), pcw.num(170, "R")
    blank_cost = round((width * blank_len / 144.0) * lb_ft2 * ppl, 6)
    laser_hrs_100 = laser.num(34, "F")
    # The minimum-charge strip is an *input* to the case: without it a test
    # cannot reproduce min_charge, and hand-typing 12 would be exactly the
    # copying REQUIREMENTS §9 warns against. Solved, not read -- see
    # extract_shop_defaults().
    strip_in = int(round(pcw.num(7, "W") * 144.0 / (width * lb_ft2 * ppl)))

    return {
        "_comment": (
            "Generated by scripts/extract-workbook.py from "
            "docs/reference/Quote_Metal_Cost.xls. REQUIREMENTS §9. "
            "Do not hand-edit: if a calc test disagrees, fix the engine. "
            "Assert only `expected` and `intermediates`; everything else is "
            "input. Do not add assertions on other workbook numbers."
        ),
        "generated": date.today().isoformat(),
        "material": {
            "name": pcw.text(170, "C"),
            "lb_per_sq_ft": lb_ft2,
            "price_per_lb": ppl,
            "speed_in_min": pcw.num(170, "L"),
            "pierce_s": pcw.num(170, "P"),
            "std_length_in": pcw.num(170, "S"),
        },
        "part": {
            "flat_length_in": pcw.num(3, "T"),
            "flat_width_in": pcw.num(3, "S"),
            "blank_area_sq_in": pcw.num(3, "U"),
            "blank_lbs": pcw.num(3, "W"),
        },
        "nesting": {
            "process": "Punch" if pcw.num(5, "Q") == 2 else "Laser",
            "clamp_in": pcw.num(7, "P"),
            "kerf_in": pcw.num(7, "Q"),
            "stock_width_in": width,
            "blank_length_in": blank_len,
            "parts_per_blank": pcw.num(5, "U"),
        },
        "laser": {
            "perimeter_cut_in": laser.num(28, "F"),
            "pierces": laser.num(26, "B"),
            "intersections": laser.num(30, "F"),
            "speed_in_min": laser.num(23, "I"),
            "pierce_s": laser.num(21, "I"),
            "pallet_change_s": laser.num(30, "I"),
        },
        "laser_op": {
            "setup_hrs": pcw.num(33, "D"),
            "rate_per_hr": pcw.num(33, "H"),
            "fixed_dollars": pcw.num(33, "I"),
        },
        "coating": {
            "perimeter_in": pcw.num(52, "V"),
        },
        "config": {
            "_note": (
                "Fixed cost for this quote is the setup roll-up -- the laser's "
                "0.2 h x $100 = $20, carried in laser_op.fixed_dollars -- not a "
                "shop constant (REQUIREMENTS §5.6). The workbook's D13 = 20 is "
                "that same sum, so the flat per-job adder here is 0."
            ),
            "shop_fixed_cost_per_job": 0.0,
            "labor_markup": pcw.num(10, "C"),
            "material_markup": pcw.num(10, "D"),
            "min_charge_strip_in": strip_in,
            "nre_total": pcw.num(24, "L"),
        },
        "intermediates": {
            "_note": (
                "The five numbers the engine is held to besides `expected`. "
                "laser_hours_per_part is the workbook's %.6f hours per 100 "
                "divided by 100: same quantity, engine units (§11.4 makes "
                "per-100 a display convention, not a representation)."
            ) % laser_hrs_100,
            "blank_cost": blank_cost,
            "min_charge": pcw.num(7, "W"),
            "material_per_part": pcw.num(16, "D"),
            "material_at_qty_1": pcw.num(16, "E"),
            "laser_hours_per_part": laser_hrs_100 / 100.0,
        },
        "quantity_breaks": [int(pcw.num(12, c)) for c in ("E", "F", "G", "H", "I", "J")],
        "expected": {
            "selling_price": [pcw.num(r, "I") for r in range(5, 11)],
            "material_pct_of_selling": [pcw.num(r, "L") for r in range(5, 11)],
        },
        "tolerance": {"selling_price": 0.005, "material_pct_of_selling": 0.001},
    }


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
def write_json(path: Path, payload) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return len(payload) if isinstance(payload, list) else 1


MARK_START = "<!-- extract-workbook:start -->"
MARK_END = "<!-- extract-workbook:end -->"


def write_discovery() -> None:
    """Refresh only our own delimited block so hand-written Phase 0.1 notes
    (the answers to REQUIREMENTS §10) survive a re-run."""
    lines = [
        MARK_START,
        "## Unresolved cells",
        "",
        f"_Generated by `scripts/extract-workbook.py` on {date.today().isoformat()}._",
        "",
    ]
    if not unresolved:
        lines += ["Nothing unresolved.", ""]
    else:
        by_table: dict[str, list[dict]] = {}
        for u in unresolved:
            by_table.setdefault(u["table"], []).append(u)
        lines += [f"{len(unresolved)} cells could not be resolved without an owner answer.", ""]
        for table in sorted(by_table):
            lines.append(f"### {table}")
            lines.append("")
            lines.append("| cell | field | why |")
            lines.append("|---|---|---|")
            for u in by_table[table]:
                lines.append(f"| `{u['cell']}` | `{u['field']}` | {u['why']} |")
            lines.append("")
    lines.append(MARK_END)
    block = "\n".join(lines)

    DISCOVERY.parent.mkdir(parents=True, exist_ok=True)
    if DISCOVERY.exists():
        old = DISCOVERY.read_text(encoding="utf-8")
        if MARK_START in old and MARK_END in old:
            head, rest = old.split(MARK_START, 1)
            _, tail = rest.split(MARK_END, 1)
            DISCOVERY.write_text(head + block + tail, encoding="utf-8")
            return
        DISCOVERY.write_text(old.rstrip() + "\n\n" + block + "\n", encoding="utf-8")
        return
    DISCOVERY.write_text(
        "# Discovery notes\n\n"
        "Answers to REQUIREMENTS §10 go above this line (BUILD-PLAN Task 0.1).\n\n"
        + block + "\n",
        encoding="utf-8",
    )


def main() -> int:
    if not XLS.exists():
        sys.exit(f"workbook not found: {XLS}")

    book = xlrd.open_workbook(XLS)
    pcw = Sheet(book, SHEET)
    laser = Sheet(book, LASER_SHEET)
    assy = Sheet(book, ASSY_SHEET)

    outputs = [
        ("materials.json", extract_materials(pcw)),
        ("operations.json", extract_operations(pcw)),
        ("plating.json", extract_plating(pcw)),
        ("coating.json", extract_coating(pcw)),
        ("silkscreen.json", extract_silkscreen(pcw)),
        ("assembly_standards.json", extract_assembly(assy)),
        ("punch_rates.json", extract_punch_rates(pcw)),
        ("blank_multiples.json", extract_blank_multiples(pcw)),
        ("process_presets.json", extract_process_presets(pcw)),
        ("shop_defaults.json", extract_shop_defaults(pcw)),
    ]

    print(f"Reading {XLS.relative_to(ROOT)}\n")
    print(f"{'file':28} {'rows':>5}  {'destination'}")
    print("-" * 78)
    for filename, payload in outputs:
        n = write_json(SEED_DIR / filename, payload)
        kind = f"{n}" if isinstance(payload, list) else "obj"
        print(f"{filename:28} {kind:>5}  packages/db/seed/")

    golden = extract_golden(pcw, laser)
    write_json(FIXTURE_DIR / "golden-workbook.json", golden)
    print(f"{'golden-workbook.json':28} {'obj':>5}  packages/calc/test/fixtures/")

    write_discovery()

    # --- Acceptance check from BUILD-PLAN Task 0.2 -------------------------
    expected = [37.8286, 8.7413, 6.3413, 4.7413, 4.4213, 4.1813]
    actual = golden["expected"]["selling_price"]
    print(f"\nGolden selling prices (REQUIREMENTS §9)")
    print(f"{'qty':>5} {'expected':>12} {'workbook':>12}  ")
    ok = True
    for qty, exp, act in zip(golden["quantity_breaks"], expected, actual):
        good = act is not None and abs(act - exp) <= 0.005
        ok &= good
        print(f"{qty:>5} {exp:>12.4f} {act:>12.5f}  {'ok' if good else 'MISMATCH'}")

    # The five named intermediates (docs/course-correction.md §3) are part of
    # the oracle, so a drifting workbook trips this too, not just the prices.
    inter = golden["intermediates"]
    expected_inter = {
        "blank_cost": 68.8358,
        "min_charge": 8.6045,
        "material_per_part": 2.0859,
        "material_at_qty_1": 10.3254,
        "laser_hours_per_part": 0.0052255,
    }
    print()
    print("Golden intermediates")
    for field, exp in expected_inter.items():
        act = inter[field]
        good = act is not None and abs(act - exp) <= 0.0001
        ok &= good
        print(f"{field:>22} {exp:>12.4f} {act:>14.6f}  {'ok' if good else 'MISMATCH'}")

    k = round(pcw.num(33, "G") * pcw.num(33, "F") / pcw.num(33, "E"), 6)
    print()
    print(f"Quirk Q2 machine-op factor, observed G33*F33/E33 = {k:g} "
          f"-> parity.machineTimeFactor {k / 100:g}")
    print(f"Laser kerf -> Machine.kerfIn, a Settings field (Q5 withdrawn): "
          f"{golden['nesting']['kerf_in']}")

    if unresolved:
        print(f"\n{len(unresolved)} unresolved cell(s) -> docs/discovery.md")
        for u in unresolved[:6]:
            print(f"  {u['table']:14} {u['cell']:10} {u['field']}")
        if len(unresolved) > 6:
            print(f"  ... and {len(unresolved) - 6} more")

    print("\nOK" if ok else "\nFAILED: golden oracle does not match REQUIREMENTS §9")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
