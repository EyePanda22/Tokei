"""
Tokei GSM live sessions: plugins.py shim (safe install)

This is the small snippet you add to your existing GSM user plugins file:
  %APPDATA%\\GameSentenceMiner\\plugins.py

Setup (recommended):
  1) Create this helper file next to plugins.py:
     %APPDATA%\\GameSentenceMiner\\tokei_live_sync.py
     (copy from: extras/gsm-plugin/tokei_live_sync.py)

  2) Paste this shim near the bottom of your plugins.py (recommended).

This approach avoids overwriting your existing plugins.py.
"""

try:
    # Newer GSM versions
    from GameSentenceMiner.util.logging_config import logger  # type: ignore
except Exception:
    try:
        # Older GSM versions
        from GameSentenceMiner.util.configuration import logger  # type: ignore
    except Exception:
        import logging

        logger = logging.getLogger("tokei.gsm_live")  # type: ignore


def _tokei_live_sync_run() -> None:
    try:
        try:
            import tokei_live_sync  # type: ignore
        except Exception:
            # Some GSM setups execute plugins.py without adding its folder to sys.path.
            # Fall back to loading the module by absolute path next to plugins.py.
            import importlib.util
            import os

            helper_path = os.path.join(os.path.dirname(__file__), "tokei_live_sync.py")
            spec = importlib.util.spec_from_file_location("tokei_live_sync", helper_path)
            if not spec or not spec.loader:
                raise ImportError(f"Could not load tokei_live_sync from {helper_path}")
            tokei_live_sync = importlib.util.module_from_spec(spec)  # type: ignore[assignment]
            spec.loader.exec_module(tokei_live_sync)  # type: ignore[arg-type]

        tokei_live_sync.main()  # type: ignore[attr-defined]
    except Exception as e:
        logger.info(f"[Tokei] GSM live sync failed: {e}")


# If the user already has a main(), preserve it and run Tokei afterward.
try:
    _gsm_user_main = main  # type: ignore[name-defined]
except Exception:
    _gsm_user_main = None


def main():  # GSM entry point
    if callable(_gsm_user_main):
        try:
            _gsm_user_main()
        except Exception as e:
            logger.info(f"[Tokei] GSM existing main() failed: {e}")
    _tokei_live_sync_run()

