import os
from pathlib import Path
import platform


def get_anki_path():
    appdata = None
    os_name = platform.system()
    if os_name == 'Windows':
        appdata = os.environ.get('APPDATA')
    elif os_name == 'Linux':
        appdata = str(Path('~/.local/share').expanduser())
    return appdata


def get_gsm_path():
    appdata = None
    os_name = platform.system()
    if os_name == 'Windows':
        appdata = os.environ.get('APPDATA')
    elif os_name == 'Linux':
        appdata = str(Path('~/.config').expanduser())
    return appdata
