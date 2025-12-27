from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ErrorKind:
    name: str
    exit_code: int


CONFIG = ErrorKind("ConfigError", 10)
API = ErrorKind("ApiError", 11)
DATABASE = ErrorKind("DatabaseError", 12)
OUTPUT = ErrorKind("OutputError", 13)


class TokeiError(RuntimeError):
    kind: ErrorKind

    def __init__(self, message: str, *, kind: ErrorKind):
        super().__init__(message)
        self.kind = kind

    @property
    def exit_code(self) -> int:
        return int(self.kind.exit_code)


class ConfigError(TokeiError):
    def __init__(self, message: str):
        super().__init__(message, kind=CONFIG)


class ApiError(TokeiError):
    def __init__(self, message: str):
        super().__init__(message, kind=API)


class DatabaseError(TokeiError):
    def __init__(self, message: str):
        super().__init__(message, kind=DATABASE)


class OutputError(TokeiError):
    def __init__(self, message: str):
        super().__init__(message, kind=OUTPUT)

