#!/usr/bin/env python3
"""
generate-python-client.py

Code generator that parses Soroban contract WASM specifications and produces a
fully typed Python client for the Bear Protocol / Marc Stellar contracts.

The generator:
  1. Runs `stellar contract inspect` on a compiled contract WASM to extract the
     contract spec XDR.
  2. Parses exported functions, structs, and error codes from the spec.
  3. Generates Python client classes under `python/marc_stellar/` using the
     `stellar-sdk` Python package, including docstrings, PEP 484 type hints, and
     dataclasses mirroring the Rust contract types.
  4. Emits a sample Jupyter notebook at `python/demo.ipynb` demonstrating
     registration and job retrieval against testnet.

Usage:
    python scripts/generate-python-client.py \
        --wasm target/wasm32-unknown-unknown/release/marc_stellar.wasm \
        --out python/marc_stellar \
        --notebook python/demo.ipynb \
        --contract-id C... \
        --network testnet

The script is designed to be included in the contract build pipeline and is
idempotent: re-running it regenerates the client from the current WASM spec.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Data model for the parsed contract spec
# ---------------------------------------------------------------------------


@dataclass
class SpecField:
    """A single field of a struct or enum variant."""

    name: str
    type_name: str
    doc: str = ""


@dataclass
class SpecStruct:
    """A struct (or enum) exported by the contract."""

    name: str
    fields: List[SpecField] = field(default_factory=list)
    doc: str = ""
    is_enum: bool = False
    variants: List[str] = field(default_factory=list)


@dataclass
class SpecFunction:
    """An exported contract function."""

    name: str
    inputs: List[SpecField] = field(default_factory=list)
    outputs: List[str] = field(default_factory=list)
    doc: str = ""


@dataclass
class SpecError:
    """An error code exported by the contract."""

    name: str
    code: int
    doc: str = ""


@dataclass
class ContractSpec:
    """The full parsed contract specification."""

    name: str = "MarcStellar"
    functions: List[SpecFunction] = field(default_factory=list)
    structs: List[SpecStruct] = field(default_factory=list)
    errors: List[SpecError] = field(default_factory=list)


# ---------------------------------------------------------------------------
# XDR / type mapping helpers
# ---------------------------------------------------------------------------

# Mapping from Soroban / XDR scalar type names to Python type hints.
SCALAR_TYPE_MAP: Dict[str, str] = {
    "Address": "str",
    "AccountId": "str",
    "ScAddress": "str",
    "ScString": "str",
    "String": "str",
    "Symbol": "str",
    "Bytes": "bytes",
    "ScBytes": "bytes",
    "Data": "bytes",
    "U32": "int",
    "U64": "int",
    "U128": "int",
    "U256": "int",
    "I32": "int",
    "I64": "int",
    "I128": "int",
    "I256": "int",
    "Timepoint": "int",
    "Duration": "int",
    "Bool": "bool",
    "Void": "None",
    "ScVal": "Any",
    "Val": "Any",
    "ScError": "Any",
}

# Mapping from Soroban / XDR type names to stellar-sdk Python converter helpers.
SCALAR_CONVERTER_MAP: Dict[str, str] = {
    "Address": "address_to_scval",
    "AccountId": "address_to_scval",
    "ScAddress": "address_to_scval",
    "ScString": "string_to_scval",
    "String": "string_to_scval",
    "Symbol": "symbol_to_scval",
    "Bytes": "bytes_to_scval",
    "ScBytes": "bytes_to_scval",
    "Data": "bytes_to_scval",
    "U32": "int_to_scval",
    "U64": "int_to_scval",
    "U128": "int_to_scval",
    "U256": "int_to_scval",
    "I32": "int_to_scval",
    "I64": "int_to_scval",
    "I128": "int_to_scval",
    "I256": "int_to_scval",
    "Timepoint": "int_to_scval",
    "Duration": "int_to_scval",
    "Bool": "bool_to_scval",
    "Void": "void_to_scval",
    "ScVal": "identity_scval",
    "Val": "identity_scval",
}


def normalize_type_name(raw: str) -> str:
    """Normalize an XDR type name into a canonical form.

    Handles common prefixes such as ``Scv`` / ``Sc`` and strips whitespace.
    """
    if raw is None:
        return "Val"
    name = raw.strip()
    # Strip common XDR prefixes so lookups are stable.
    for prefix in ("Scv", "Sc", "ScSpec"):
        if name.startswith(prefix) and name[len(prefix):] in SCALAR_TYPE_MAP:
            name = name[len(prefix):]
            break
    return name


def python_type_for(type_name: str, known_structs: Optional[set] = None) -> str:
    """Return a PEP 484 type hint for a given XDR type name."""
    known_structs = known_structs or set()
    name = normalize_type_name(type_name)

    if name in SCALAR_TYPE_MAP:
        return SCALAR_TYPE_MAP[name]

    # Option<T> / Optional handling.
    if name.startswith("Option<") and name.endswith(">"):
        inner = name[len("Option<"):-1]
        return f"Optional[{python_type_for(inner, known_structs)}]"

    # Vec<T> / list handling.
    if name.startswith("Vec<") and name.endswith(">"):
        inner = name[len("Vec<"):-1]
        return f"List[{python_type_for(inner, known_structs)}]"

    # Map<K, V> handling.
    if name.startswith("Map<") and name.endswith(">"):
        inner = name[len("Map<"):-1]
        parts = split_generic_args(inner)
        if len(parts) == 2:
            return (
                f"Dict[{python_type_for(parts[0], known_structs)}, "
                f"{python_type_for(parts[1], known_structs)}]"
            )
        return "Dict[Any, Any]"

    # Tuple handling.
    if name.startswith("Tuple<") and name.endswith(">"):
        inner = name[len("Tuple<"):-1]
        parts = split_generic_args(inner)
        inner_types = ", ".join(python_type_for(p, known_structs) for p in parts)
        return f"Tuple[{inner_types}]"

    # User-defined struct / enum.
    if name in known_structs:
        return name

    # Fall back to Any for unknown types.
    return "Any"


def split_generic_args(inner: str) -> List[str]:
    """Split a comma-separated generic argument list, respecting nesting."""
    parts: List[str] = []
    depth = 0
    current = []
    for ch in inner:
        if ch in "<([":
            depth += 1
        elif ch in ">)]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current).strip())
    return [p for p in parts if p]


def converter_for(type_name: str, known_structs: Optional[set] = None) -> str:
    """Return the name of the stellar-sdk converter helper for a type."""
    known_structs = known_structs or set()
    name = normalize_type_name(type_name)

    if name in SCALAR_CONVERTER_MAP:
        return SCALAR_CONVERTER_MAP[name]

    if name.startswith("Option<") and name.endswith(">"):
        return "option_to_scval"

    if name.startswith("Vec<") and name.endswith(">"):
        return "vec_to_scval"

    if name.startswith("Map<") and name.endswith(">"):
        return "map_to_scval"

    if name.startswith("Tuple<") and name.endswith(">"):
        return "tuple_to_scval"

    if name in known_structs:
        return "struct_to_scval"

    return "identity_scval"


# ---------------------------------------------------------------------------
# Spec extraction
# ---------------------------------------------------------------------------


def run_stellar_inspect(wasm_path: Path) -> str:
    """Run `stellar contract inspect` and return the raw output.

    Falls back to a JSON spec file next to the WASM if the stellar CLI is not
    available, which keeps the generator usable in CI environments without the
    full Stellar toolchain installed.
    """
    if shutil.which("stellar") is not None:
        cmd = [
            "stellar",
            "contract",
            "inspect",
            "--wasm",
            str(wasm_path),
            "--output",
            "json",
        ]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
            )
            return result.stdout
        except subprocess.CalledProcessError as exc:
            sys.stderr.write(
                f"warning: `stellar contract inspect` failed: {exc.stderr}\n"
            )

    # Fallback: look for a sibling JSON spec file.
    fallback = wasm_path.with_suffix(".spec.json")
    if fallback.exists():
        return fallback.read_text(encoding="utf-8")

    fallback = wasm_path.with_suffix(".json")
    if fallback.exists():
        return fallback.read_text(encoding="utf-8")

    raise RuntimeError(
        "Unable to extract contract spec: `stellar` CLI not found and no "
        f"fallback spec JSON exists next to {wasm_path}"
    )


def parse_spec(raw_output: str) -> ContractSpec:
    """Parse the JSON output of `stellar contract inspect` into a ContractSpec."""
    try:
        data = json.loads(raw_output)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse contract spec JSON: {exc}") from exc

    spec = ContractSpec()

    # The inspect output may be wrapped in a top-level object.
    if isinstance(data, dict):
        if "spec" in data and isinstance(data["spec"], dict):
            data = data["spec"]
        if "name" in data and isinstance(data["name"], str):
            spec.name = data["name"]

    # --- Functions ---------------------------------------------------------
    functions = data.get("functions", []) if isinstance(data, dict) else []
    for fn in functions:
        name = fn.get("name", "")
        if not name:
            continue
        inputs: List[SpecField] = []
        for inp in fn.get("inputs", []) or fn.get("params", []) or []:
            inputs.append(
                SpecField(
                    name=inp.get("name", "arg"),
                    type_name=inp.get("type", inp.get("type_name", "Val")),
                    doc=inp.get("doc", ""),
                )
            )
        outputs: List[str] = []
        raw_outputs = fn.get("outputs", fn.get("output", []))
        if isinstance(raw_outputs, str):
            outputs = [raw_outputs]
        elif isinstance(raw_outputs, list):
            for out in raw_outputs:
                if isinstance(out, str):
                    outputs.append(out)
                elif isinstance(out, dict):
                    outputs.append(out.get("type", out.get("type_name", "Val")))
        spec.functions.append(
            SpecFunction(
                name=name,
                inputs=inputs,
                outputs=outputs,
                doc=fn.get("doc", ""),
            )
        )

    # --- Structs / enums ---------------------------------------------------
    structs = data.get("structs", []) if isinstance(data, dict) else []
    for st in structs:
        name = st.get("name", "")
        if not name:
            continue
        fields: List[SpecField] = []
        for fld in st.get("fields", []) or []:
            fields.append(
                SpecField(
                    name=fld.get("name", "field"),
                    type_name=fld.get("type", fld.get("type_name", "Val")),
                    doc=fld.get("doc", ""),
                )
            )
        spec.structs.append(
            SpecStruct(
                name=name,
                fields=fields,
                doc=st.get("doc", ""),
                is_enum=bool(st.get("is_enum", False)),
                variants=list(st.get("variants", []) or []),
            )
        )

    # --- Errors ------------------------------------------------------------
    errors = data.get("errors", []) if isinstance(data, dict) else []
    for err in errors:
        name = err.get("name", "")
        if not name:
            continue
        spec.errors.append(
            SpecError(
                name=name,
                code=int(err.get("code", 0)),
                doc=err.get("doc", ""),
            )
        )

    return spec


# ---------------------------------------------------------------------------
# Code generation
# ---------------------------------------------------------------------------

HEADER = '''"""Auto-generated Python client for the {contract_name} Soroban contract.

DO NOT EDIT THIS FILE BY HAND.

This module is generated by ``scripts/generate-python-client.py`` from the
compiled contract WASM specification. Re-run the generator after changing the
Rust contract to keep this client in sync.

The client is built on top of the ``stellar-sdk`` Python package and exposes
fully typed (PEP 484) methods for every exported contract function, along with
dataclasses mirroring the Rust contract types.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from stellar_sdk import (
    Keypair,
    Network,
    SorobanServer,
    TransactionBuilder,
)
from stellar_sdk.soroban_rpc import SorobanServer as _SorobanServer
from stellar_sdk.xdr import SCVal, SCValType, SCAddress, SCAddressType
from stellar_sdk.xdr.sc_val import SCVal as _SCVal
from stellar_sdk.xdr.sc_string import SCString
from stellar_sdk.xdr.sc_symbol import SCSymbol
from stellar_sdk.xdr.sc_bytes import SCBytes
from stellar_sdk.xdr.sc_address import SCAddress as _SCAddress
from stellar_sdk.xdr.sc_address_type import SCAddressType as _SCAddressType
from stellar_sdk.xdr.sc_non_void import SCNonVoid
from stellar_sdk.xdr.sc_vec import SCVec
from stellar_sdk.xdr.sc_map import SCMap
from stellar_sdk.xdr.sc_map_entry import SCMapEntry
from stellar_sdk.xdr.int32 import Int32
from stellar_sdk.xdr.uint32 import Uint32
from stellar_sdk.xdr.int64 import Int64
from stellar_sdk.xdr.uint64 import Uint64
from stellar_sdk.xdr.sc_error import SCError
from stellar_sdk.xdr.sc_error_code import SCErrorCode
from stellar_sdk.xdr.sc_error_type import SCErrorType


__all__ = [
{all_exports}
]


# ---------------------------------------------------------------------------
# SCVal conversion helpers
# ---------------------------------------------------------------------------


def address_to_scval(value: str) -> SCVal:
    """Convert a Stellar address string into an ``SCVal`` address."""
    return SCVal(type=SCValType.SCV_ADDRESS, address=_SCAddress.from_string(value))


def string_to_scval(value: str) -> SCVal:
    """Convert a Python string into an ``SCVal`` string."""
    return SCVal(type=SCValType.SCV_STRING, str=SCString(value))


def symbol_to_scval(value: str) -> SCVal:
    """Convert a Python string into an ``SCVal`` symbol."""
    return SCVal(type=SCValType.SCV_SYMBOL, sym=SCSymbol(value))


def bytes_to_scval(value: bytes) -> SCVal:
    """Convert Python bytes into an ``SCVal`` bytes value."""
    return SCVal(type=SCValType.SCV_BYTES, bytes=SCBytes(value))


def int_to_scval(value: int) -> SCVal:
    """Convert a Python int into an ``SCVal`` i128 value."""
    return SCVal(type=SCValType.SCV_I128, i128=Int128(value))


def bool_to_scval(value: bool) -> SCVal:
    """Convert a Python bool into an ``SCVal`` boolean."""
    return SCVal(type=SCValType.SCV_BOOL, b=value)


def void_to_scval(value: Any = None) -> SCVal:
    """Return the ``SCVal`` void value."""
    return SCVal(type=SCValType.SCV_VOID)


def identity_scval(value: Any) -> SCVal:
    """Pass through an already-constructed ``SCVal``."""
    if isinstance(value, SCVal):
        return value
    raise TypeError(f"Expected SCVal, got {type(value)!r}")


def option_to_scval(value: Any) -> SCVal:
    """Convert an optional value into an ``SCVal``."""
    if value is None:
        return SCVal(type=SCValType.SCV_VOID)
    return identity_scval(value)


def vec_to_scval(value: List[Any]) -> SCVal:
    """Convert a list of ``SCVal`` into an ``SCVal`` vector."""
    return SCVal(
        type=SCValType.SCV_VEC,
        vec=SCVec([identity_scval(v) for v in value]),
    )


def map_to_scval(value: Dict[Any, Any]) -> SCVal:
    """Convert a dict of ``SCVal`` into an ``SCVal`` map."""
    entries = [
        SCMapEntry(key=identity_scval(k), val=identity_scval(v))
        for k, v in value.items()
    ]
    return SCVal(type=SCValType.SCV_MAP, map=SCMap(entries))


def tuple_to_scval(value: Tuple[Any, ...]) -> SCVal:
    """Convert a tuple of ``SCVal`` into an ``SCVal`` vector."""
    return vec_to_scval(list(value))


def struct_to_scval(value: Any) -> SCVal:
    """Convert a generated dataclass into an ``SCVal`` map."""
    if dataclasses.is_dataclass(value):
        entries = []
        for f in dataclasses.fields(value):
            entries.append(
                SCMapEntry(
                    key=symbol_to_scval(f.name),
                    val=identity_scval(getattr(value, f.name)),
                )
            )
        return SCVal(type=SCValType.SCV_MAP, map=SCMap(entries))
    return identity_scval(value)


def scval_to_python(value: SCVal) -> Any:
    """Best-effort conversion of an ``SCVal`` into a native Python value."""
    if value is None:
        return None
    t = value.type
    if t == SCValType.SCV_VOID:
        return None
    if t == SCValType.SCV_BOOL:
        return value.b
    if t == SCValType.SCV_STRING:
        return value.str.sc_string if value.str is not None else ""
    if t == SCValType.SCV_SYMBOL:
        return value.sym.sc_symbol if value.sym is not None else ""
    if t == SCValType.SCV_BYTES:
        return value.bytes.sc_bytes if value.bytes is not None else b""
    if t in (SCValType.SCV_I32, SCValType.SCV_U32):
        return value.i32 if value.i32 is not None else value.u32
    if t in (SCValType.SCV_I64, SCValType.SCV_U64):
        return value.i64 if value.i64 is not None else value.u64
    if t in (SCValType.SCV_I128, SCValType.SCV_U128):
        return value.i128 if value.i128 is not None else value.u128
    if t == SCValType.SCV_ADDRESS:
        return value.address.to_string() if value.address is not None else None
    if t == SCValType.SCV_VEC:
        return [scval_to_python(v) for v in (value.vec.sc_vec if value.vec else [])]
    if t == SCValType.SCV_MAP:
        result = {}
        for entry in (value.map.sc_map if value.map else []):
            key = scval_to_python(entry.key)
            result[key] = scval_to_python(entry.val)
        return result
    return value


# ---------------------------------------------------------------------------
# Error definitions
# ---------------------------------------------------------------------------


class {contract_name}Error(Exception):
    """Base exception for errors returned by the {contract_name} contract."""


{error_classes}

ERROR_CODE_MAP: Dict[int, type] = {{
{error_map}
}}


def raise_for_error(code: int, message: str = "") -> None:
    """Raise the appropriate exception for a contract error code."""
    exc_type = ERROR_CODE_MAP.get(code)
    if exc_type is not None:
        raise exc_type(message or exc_type.__doc__ or "contract error")
    raise {contract_name}Error(f"unknown contract error {{code}}: {{message}}")


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


{struct_classes}

# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class {contract_name}Client:
    """Typed Python client for the {contract_name} Soroban contract.

    Example:
        >>> client = {contract_name}Client(
        ...     contract_id="C...",
        ...     rpc_url="https://soroban-testnet.stellar.org",
        ...     network_passphrase="Test SDF Network ; September 2015",
        ...     source_secret="S...",
        ... )
        >>> client.register_agent(...)
    """

    def __init__(
        self,
        contract_id: str,
        rpc_url: str = "https://soroban-testnet.stellar.org",
        network_passphrase: str = "Test SDF Network ; September 2015",
        source_secret: Optional[str] = None,
    ) -> None:
        self.contract_id = contract_id
        self.rpc_url = rpc_url
        self.network_passphrase = network_passphrase
        self.server = SorobanServer(rpc_url)
        self.source_secret = source_secret
        self._source_keypair: Optional[Keypair] = (
            Keypair.from_secret(source_secret) if source_secret else None
        )

    # -- internal helpers -------------------------------------------------

    def _source_account(self):
        if self._source_keypair is None:
            raise ValueError(
                "A source_secret is required to submit transactions."
            )
        return self.server.load_account(self._source_keypair.public_key)

    def _build_invoke(
        self,
        function_name: str,
        args: List[SCVal],
    ):
        source_account = self._source_account()
        tx = (
            TransactionBuilder(
                source_account=source_account,
                network_passphrase=self.network_passphrase,
                base_fee=100,
            )
            .append_invoke_contract_function_op(
                contract_id=self.contract_id,
                function_name=function_name,
                parameters=args,
            )
            .set_timeout(30)
            .build()
        )
        return tx

    def _invoke(self, function_name: str, args: List[SCVal]) -> Any:
        tx = self._build_invoke(function_name, args)
        prepared = self.server.prepare_transaction(tx)
        prepared.sign(self._source_keypair)
        response = self.server.send_transaction(prepared)
        result = self.server.poll_transaction(response)
        if result.status != "SUCCESS":
            raise {contract_name}Error(
                f"transaction failed: {{result.status}}"
            )
        return result

    def _simulate(self, function_name: str, args: List[SCVal]) -> Any:
        source_account = self._source_account()
        tx = (
            TransactionBuilder(
                source_account=source_account,
                network_passphrase=self.network_passphrase,
                base_fee=100,
            )
            .append_invoke_contract_function_op(
                contract_id=self.contract_id,
                function_name=function_name,
                parameters=args,
            )
            .set_timeout(30)
            .build()
        )
        sim = self.server.simulate_transaction(tx)
        if sim.error:
            raise {contract_name}Error(str(sim.error))
        return sim

{function_methods}
'''


def generate_error_classes(spec: ContractSpec) -> Tuple[str, str]:
    """Generate error class definitions and the error code map."""
    lines: List[str] = []
    map_lines: List[str] = []
    for err in spec.errors:
        doc = err.doc or f"Contract error {err.name} (code {err.code})."
        lines.append(
            textwrap.dedent(
                f'''\
                class {err.name}({spec.name}Error):
                    """{doc}"""

                    code = {err.code}
                '''
            )
        )
        map_lines.append(f"    {err.code}: {err.name},")
    if not lines:
        lines.append(
            textwrap.dedent(
                f'''\
                class {spec.name}UnknownError({spec.name}Error):
                    """Fallback error for unknown contract error codes."""
                '''
            )
        )
    return "\n\n".join(lines), "\n".join(map_lines)


def generate_struct_classes(spec: ContractSpec) -> str:
    """Generate dataclass definitions mirroring the Rust contract types."""
    known = {s.name for s in spec.structs}
    blocks: List[str] = []
    for st in spec.structs:
        doc = st.doc or f"Dataclass mirroring the Rust ``{st.name}`` type."
        if st.is_enum and st.variants:
            variant_lines = "\n".join(
                f'    {v.upper()} = "{v}"' for v in st.variants
            )
            blocks.append(
                textwrap.dedent(
                    f'''\
                    class {st.name}:
                        """{doc}"""

                    {variant_lines}
                    '''
                )
            )
            continue

        field_lines: List[str] = []
        for fld in st.fields:
            py_type = python_type_for(fld.type_name, known)
            default = " = None" if py_type.startswith("Optional[") else ""
            field_doc = f"  # {fld.doc}" if fld.doc else ""
            field_lines.append(f"    {fld.name}: {py_type}{default}{field_doc}")
        if not field_lines:
            field_lines.append("    pass")

        blocks.append(
            textwrap.dedent(
                f'''\
                @dataclass
                class {st.name}:
                    """{doc}"""

                {chr(10).join(field_lines)}
                '''
            )
        )
    if not blocks:
        blocks.append(
            textwrap.dedent(
                '''\
                @dataclass
                class ContractResult:
                    """Generic result wrapper returned by contract calls."""

                    value: Any = None
                '''
            )
        )
    return "\n\n".join(blocks)


def generate_function_methods(spec: ContractSpec) -> str:
    """Generate typed client methods for every exported contract function."""
    known = {s.name for s in spec.structs}
    methods: List[str] = []
    for fn in spec.functions:
        params: List[str] = ["self"]
        for inp in fn.inputs:
            py_type = python_type_for(inp.type_name, known)
            params.append(f"{inp.name}: {py_type}")
        signature = ", ".join(params)

        doc = fn.doc or f"Invoke the ``{fn.name}`` contract function."
        arg_docs = "\n".join(
            f"            {inp.name}: {inp.doc or inp.type_name}"
            for inp in fn.inputs
        )
        if arg_docs:
            arg_docs = f"\n\n        Args:\n{arg_docs}"

        # Build the SCVal argument list.
        arg_exprs: List[str] = []
        for inp in fn.inputs:
            converter = converter_for(inp.type_name, known)
            arg_exprs.append(f"{converter}({inp.name})")
        args_list = ", ".join(arg_exprs)

        # Determine return type.
        if fn.outputs:
            ret_type = python_type_for(fn.outputs[0], known)
        else:
            ret_type = "None"

        # Read-only functions (no inputs that look like state changes) are
        # simulated; everything else is submitted as a transaction.
        is_read_only = fn.name.startswith(("get_", "read_", "query_", "view_"))
        invoke_call = (
            f"self._simulate({fn.name!r}, [{args_list}])"
            if is_read_only
            else f"self._invoke({fn.name!r}, [{args_list}])"
        )

        method = textwrap.dedent(
            f'''\
                def {fn.name}({signature}) -> {ret_type}:
                    """{doc}{arg_docs}

                    Returns:
                        {ret_type}
                    """
                    result = {invoke_call}
                    return scval_to_python(result)  # type: ignore[return-value]
            '''
        )
        methods.append(method)
    if not methods:
        methods.append(
            textwrap.dedent(
                '''\
                def ping(self) -> str:
                    """Placeholder method when no functions are exported."""
                    return "pong"
                '''
            )
        )
    return "\n".join(methods)


def generate_client(spec: ContractSpec) -> str:
    """Render the full Python client module source."""
    error_classes, error_map = generate_error_classes(spec)
    struct_classes = generate_struct_classes(spec)
    function_methods = generate_function_methods(spec)

    exports: List[str] = [
        f'    "{spec.name}Client",',
        f'    "{spec.name}Error",',
        '    "scval_to_python",',
    ]
    for st in spec.structs:
        exports.append(f'    "{st.name}",')
    for err in spec.errors:
        exports.append(f'    "{err.name}",')
    all_exports = "\n".join(exports)

    return HEADER.format(
        contract_name=spec.name,
        all_exports=all_exports,
        error_classes=error_classes,
        error_map=error_map,
        struct_classes=struct_classes,
        function_methods=function_methods,
    )


def generate_init(spec: ContractSpec) -> str:
    """Render the package ``__init__.py``."""
    return textwrap.dedent(
        f'''\
        """Python client package for the {spec.name} Soroban contract.

        This package is auto-generated by ``scripts/generate-python-client.py``.
        """

        from .client import (
            {spec.name}Client,
            {spec.name}Error,
            scval_to_python,
        )

        __all__ = [
            "{spec.name}Client",
            "{spec.name}Error",
            "scval_to_python",
        ]

        __version__ = "0.1.0"
        '''
    )


def generate_pyproject(spec: ContractSpec) -> str:
    """Render a minimal ``pyproject.toml`` for the generated package."""
    return textwrap.dedent(
        f'''\
        [build-system]
        requires = ["setuptools>=61.0", "wheel"]
        build-backend = "setuptools.build_meta"

        [project]
        name = "marc-stellar"
        version = "0.1.0"
        description = "Auto-generated Python client for the {spec.name} Soroban contract"
        readme = "README.md"
        requires-python = ">=3.9"
        dependencies = [
            "stellar-sdk>=10.0.0",
        ]

        [project.optional-dependencies]
        demo = [
            "jupyter",
            "notebook",
        ]

        [tool.setuptools.packages.find]
        where = ["."]
        include = ["marc_stellar*"]
        '''
    )


# ---------------------------------------------------------------------------
# Notebook generation
# ---------------------------------------------------------------------------


def generate_notebook(spec: ContractSpec, contract_id: str, network: str) -> str:
    """Render a sample Jupyter notebook demonstrating the generated client."""
    rpc_url = (
        "https://soroban-testnet.stellar.org"
        if network == "testnet"
        else "https://soroban-mainnet.stellar.org"
    )
    network_passphrase = (
        "Test SDF Network ; September 2015"
        if network == "testnet"
        else "Public Global Stellar Network ; September 2015"
    )

    cells: List[Dict[str, Any]] = []

    def md(source: str) -> None:
        cells.append(
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": source.splitlines(keepends=True),
            }
        )

    def code(source: str) -> None:
        cells.append(
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": source.splitlines(keepends=True),
            }
        )

    md(
        f"""# {spec.name} Python Client Demo

This notebook demonstrates using the auto-generated Python client for the
`{spec.name}` Soroban contract on **{network}**.

It shows how to:
1. Install and import the generated client.
2. Connect to the Soroban RPC endpoint.
3. Register an agent.
4. Retrieve a job by id.

The notebook runs in Google Colab or a local Jupyter environment.
"""
    )

    code(
        """# Install dependencies (skip if already installed).
# In Google Colab, uncomment the following line:
# !pip install stellar-sdk
"""
    )

    code(
        f"""import os
import sys

# Make the generated package importable when running from the repo root.
sys.path.insert(0, os.path.abspath("python"))

from marc_stellar import {spec.name}Client, {spec.name}Error

CONTRACT_ID = os.environ.get("CONTRACT_ID", "{contract_id}")
RPC_URL = os.environ.get("SOROBAN_RPC_URL", "{rpc_url}")
NETWORK_PASSPHRASE = os.environ.get(
    "NETWORK_PASSPHRASE", "{network_passphrase}"
)
SOURCE_SECRET = os.environ.get("SOURCE_SECRET", "")

print("Contract:", CONTRACT_ID)
print("RPC:", RPC_URL)
"""
    )

    code(
        f"""client = {spec.name}Client(
    contract_id=CONTRACT_ID,
    rpc_url=RPC_URL,
    network_passphrase=NETWORK_PASSPHRASE,
    source_secret=SOURCE_SECRET or None,
)
client
"""
    )

    md("## Register an agent\n\nSubmit a transaction that registers a new agent.")

    code(
        """# Register an agent. Adjust the arguments to match the contract ABI.
try:
    result = client.register_agent(
        "agent-001",  # agent id
        "0xdeadbeef",  # metadata / capability hash
    )
    print("register_agent result:", result)
except Exception as exc:  # noqa: BLE001
    print("register_agent failed:", exc)
"""
    )

    md("## Retrieve a job\n\nRead a job by id using a simulated (read-only) call.")

    code(
        """# Fetch a job by id. Read-only calls are simulated and do not require
# a funded source account.
try:
    job = client.get_job(1)
    print("job:", job)
except Exception as exc:  # noqa: BLE001
    print("get_job failed:", exc)
"""
    )

    md(
        """## Error handling

Contract errors are surfaced as typed exceptions derived from
`{name}Error`.""".format(name=spec.name)
    )

    code(
        f"""try:
    client.get_job(999999)
except {spec.name}Error as exc:
    print("contract error:", exc)
"""
    )