"""
acquired.py - Dynamic Hardware & File Reach Telemetry Daemon

Adapted from open-source references:
- farflashgroup/PrivacyDot (CoreAudioUsageReader.cs, RegistryUsageParser.cs, AppNameResolver.cs)
- AndreMiras/pycaw (WASAPI Core Audio capture session enumeration)
- gorakhargosh/watchdog (Filesystem observation over user sensitive directories)

Capabilities:
1. 100% Dynamic Discovery: Zero hardcoded app lists.
2. Dual-Engine Microphone & Camera Tracking (WASAPI + ConsentStore).
3. Personal Folder Reach Engine:
   - Continuously monitors: Pictures, Documents, Desktop, and Downloads.
   - Detects which applications are reaching into, creating, or modifying files in sensitive personal folders.
   - Correlates with Windows Restart Manager (rstrtmgr.dll) and active process contexts.
4. Writes unified telemetry to 'hardware_state.json'.
"""

import os
import re
import sys
import time
import json
import ctypes
import getpass
import threading
import traceback
from ctypes import wintypes
from collections import deque
from datetime import datetime

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(CURRENT_DIR, "collector.json")
PID_FILE = os.path.join(CURRENT_DIR, "acquired.pid")
CONSENT_STORE_BASE = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore"

# Kernel pseudo-processes have no executable path. They belong to the Windows
# core even though Windows exposes identities such as "System" and "Registry".
PSEUDO_OS_IDENTITIES = {
    "system",
    "registry",
    "memcompression",
    "secure system",
    "system idle process",
    "idle",
    "gameinput",
}

WINDOWS_EPOCH_DIFF = 116444736000000000

# ---------------------------------------------------------------------------
# Zero-Dependency Native Win32 Subsystem (kernel32, user32, winreg, ctypes)
# ---------------------------------------------------------------------------
kernel32 = ctypes.windll.kernel32
user32 = ctypes.windll.user32

class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]

def win32_get_process_exe(pid: int) -> str:
    """Retrieve full executable path for a PID using Windows QueryFullProcessImageNameW."""
    if pid <= 4:
        return ""
    # PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(0x1000, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
    finally:
        kernel32.CloseHandle(h)
    return ""

def native_pid_exists(pid: int) -> bool:
    """Check if a process is alive using kernel32.OpenProcess."""
    if pid <= 0:
        return False
    h = kernel32.OpenProcess(0x1000, False, pid)
    if h:
        try:
            code = wintypes.DWORD()
            kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(h)
    return False

def native_terminate_pid(pid: int) -> bool:
    """Terminate a process by PID."""
    h = kernel32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
    if h:
        try:
            return bool(kernel32.TerminateProcess(h, 1))
        finally:
            kernel32.CloseHandle(h)
    return False

class Win32Process:
    """Lightweight zero-dependency process wrapper providing psutil-compatible API."""
    def __init__(self, pid: int, name: str, exe: str = "", ppid: int = 0):
        self._pid = pid
        self._name = name
        self._exe = exe
        self._ppid = ppid
        self.info = {"pid": pid, "name": name, "exe": exe, "ppid": ppid}

    def pid(self) -> int:
        return self._pid

    def name(self) -> str:
        return self._name

    def exe(self) -> str:
        if not self._exe and self._pid > 4:
            self._exe = win32_get_process_exe(self._pid)
            self.info["exe"] = self._exe
        return self._exe

    def cmdline(self) -> list:
        return []

def win32_process_iter():
    """Enumerate running processes using kernel32.CreateToolhelp32Snapshot."""
    snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if snap == -1 or not snap:
        return
    pe = PROCESSENTRY32W()
    pe.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    try:
        if kernel32.Process32FirstW(snap, ctypes.byref(pe)):
            while True:
                pid = pe.th32ProcessID
                name = pe.szExeFile
                ppid = pe.th32ParentProcessID
                exe = win32_get_process_exe(pid) if pid > 4 else ""
                yield Win32Process(pid, name, exe, ppid)
                if not kernel32.Process32NextW(snap, ctypes.byref(pe)):
                    break
    finally:
        kernel32.CloseHandle(snap)

# Optional accelerators: use psutil/pycaw/watchdog if present, else zero-dependency native Win32
HAS_PSUTIL = False
try:
    import psutil
    HAS_PSUTIL = True
except Exception:
    HAS_PSUTIL = False

HAS_PYCAW = False
try:
    from pycaw.utils import AudioUtilities, AudioSession
    from pycaw.constants import EDataFlow, DEVICE_STATE
    from pycaw.api.audiopolicy import IAudioSessionControl2
    HAS_PYCAW = True
except Exception:
    HAS_PYCAW = False

HAS_WATCHDOG = False
try:
    from watchdog.observers.polling import PollingObserver
    from watchdog.events import FileSystemEventHandler
    HAS_WATCHDOG = True
except Exception:
    HAS_WATCHDOG = False

def get_process_iter():
    if HAS_PSUTIL:
        try:
            return psutil.process_iter(["pid", "name", "exe", "ppid"])
        except Exception:
            pass
    return win32_process_iter()

def get_process_by_pid(pid: int):
    if HAS_PSUTIL:
        try:
            return psutil.Process(pid)
        except Exception:
            pass
    exe = win32_get_process_exe(pid)
    name = os.path.basename(exe) if exe else f"PID-{pid}"
    return Win32Process(pid, name, exe)

def pid_is_running(pid: int) -> bool:
    if HAS_PSUTIL:
        try:
            return psutil.pid_exists(pid)
        except Exception:
            pass
    return native_pid_exists(pid)

def terminate_by_pid(pid: int):
    if HAS_PSUTIL:
        try:
            psutil.Process(pid).terminate()
            return
        except Exception:
            pass
    native_terminate_pid(pid)



# ---------------------------------------------------------------------------
# Windows Restart Manager API (Find which process is locking / touching a file)
# ---------------------------------------------------------------------------
class RM_UNIQUE_PROCESS(ctypes.Structure):
    _fields_ = [
        ("dwProcessId", wintypes.DWORD),
        ("ProcessStartTime", wintypes.FILETIME),
    ]


class RM_PROCESS_INFO(ctypes.Structure):
    _fields_ = [
        ("Process", RM_UNIQUE_PROCESS),
        ("strAppName", wintypes.WCHAR * 256),
        ("strServiceShortName", wintypes.WCHAR * 64),
        ("ApplicationType", wintypes.DWORD),
        ("AppStatus", wintypes.ULONG),
        ("TSSessionId", wintypes.DWORD),
        ("bRestartable", wintypes.BOOL),
    ]


def get_processes_locking_file(filepath: str) -> list[tuple[int, str]]:
    """Uses Windows Restart Manager (rstrtmgr.dll) to find which PID has opened or modified a file."""
    if not filepath or not os.path.exists(filepath):
        return []
    try:
        rstrt = ctypes.windll.rstrtmgr
        handle = wintypes.DWORD()
        key = (wintypes.WCHAR * 65)()
        if rstrt.RmStartSession(ctypes.byref(handle), 0, key) != 0:
            return []
        try:
            c_path = (wintypes.LPCWSTR * 1)(os.path.abspath(filepath))
            if rstrt.RmRegisterResources(handle, 1, c_path, 0, None, 0, None) != 0:
                return []
            n_proc_needed = wintypes.UINT(0)
            n_proc = wintypes.UINT(10)
            procs = (RM_PROCESS_INFO * 10)()
            reboot_reasons = wintypes.DWORD()
            if rstrt.RmGetList(handle, ctypes.byref(n_proc_needed), ctypes.byref(n_proc), procs, ctypes.byref(reboot_reasons)) == 0:
                return [(procs[i].Process.dwProcessId, procs[i].strAppName) for i in range(n_proc.value)]
            return []
        finally:
            rstrt.RmEndSession(handle)
    except Exception:
        return []


def get_foreground_process() -> tuple[int | None, str, str]:
    """Returns the current foreground PID, process name, and display name."""
    try:
        hwnd = user32.GetForegroundWindow()
        if hwnd:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value > 0:
                p = get_process_by_pid(pid.value)
                disp = get_app_display_name(p.exe(), p.name())
                return pid.value, p.name(), disp
    except Exception:
        pass
    return None, "System", "System"


def filetime_to_datetime(filetime: int):
    """Converts 64-bit Windows FILETIME to ISO string."""
    if not filetime or filetime <= 0:
        return None
    try:
        unix_sec = (filetime - WINDOWS_EPOCH_DIFF) / 10000000.0
        if unix_sec > 0:
            return datetime.fromtimestamp(unix_sec).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        pass
    return None


_DISPLAY_NAME_CACHE = {}

def get_app_display_name(exe_path: str, fallback: str) -> str:
    """Dynamically extracts official display name from binary metadata via version.dll (cached for speed)."""
    if not exe_path:
        return fallback
    if exe_path in _DISPLAY_NAME_CACHE:
        return _DISPLAY_NAME_CACHE[exe_path]
    if not os.path.exists(exe_path):
        return fallback
    try:
        v_dll = ctypes.windll.version
        size = v_dll.GetFileVersionInfoSizeW(exe_path, None)
        if size > 0:
            res = ctypes.create_string_buffer(size)
            if v_dll.GetFileVersionInfoW(exe_path, 0, size, res):
                for sub in [
                    r"\StringFileInfo\040904b0\FileDescription",
                    r"\StringFileInfo\040904b0\ProductName",
                    r"\StringFileInfo\040904e4\FileDescription",
                    r"\StringFileInfo\000004b0\FileDescription",
                ]:
                    p_buff = ctypes.c_void_p()
                    len_val = wintypes.UINT()
                    if v_dll.VerQueryValueW(res, sub, ctypes.byref(p_buff), ctypes.byref(len_val)) and len_val.value > 0:
                        val = ctypes.wstring_at(p_buff.value, len_val.value).strip("\x00").strip()
                        if val:
                            _DISPLAY_NAME_CACHE[exe_path] = val
                            return val
    except Exception:
        pass
    base = os.path.basename(exe_path)
    res = os.path.splitext(base)[0]
    _DISPLAY_NAME_CACHE[exe_path] = res
    return res


def get_running_daemon_pid():
    current_pid = os.getpid()
    if os.path.exists(PID_FILE):
        try:
            with open(PID_FILE, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content.isdigit():
                    pid = int(content)
                    if pid_is_running(pid) and pid != current_pid:
                        try:
                            proc = get_process_by_pid(pid)
                            cmd = " ".join(proc.cmdline())
                            if "acquired.py" in cmd or "python" in proc.name().lower():
                                return pid
                        except Exception:
                            pass
        except Exception:
            pass
    for p in get_process_iter():
        try:
            if p.info["pid"] == current_pid:
                continue
            cmd = p.info.get("cmdline") or []
            if any("acquired.py" in str(arg) for arg in cmd):
                return p.info["pid"]
        except Exception:
            continue
    return None


def ensure_daemon_running(interval_sec: float = 1.5):
    running_pid = get_running_daemon_pid()
    if running_pid:
        return True, running_pid
    acquired_script = os.path.join(CURRENT_DIR, "acquired.py")
    creation_flags = 0
    if sys.platform == "win32":
        import subprocess
        creation_flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
    import subprocess
    proc = subprocess.Popen(
        [sys.executable, acquired_script, str(interval_sec), "--background"],
        creationflags=creation_flags,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    try:
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(proc.pid))
    except Exception:
        pass
    return False, proc.pid


# ---------------------------------------------------------------------------
# Spatial Ring & Launch Address Engine (4-Tier Radial Sunburst Hierarchy)
# ---------------------------------------------------------------------------
class PWAShortcutResolver:
    """
    Scans Chrome Apps and Edge Apps directories to map PWA '--app-id=<id>'
    parameters back to their actual .lnk shortcut file paths in AppData.
    Uses pure-Python binary parsing for 100% resilience with zero external dependencies.
    """
    _cache = {}
    _last_scan_time = 0.0
    _CACHE_TTL = 30.0  # Rescan at most once every 30 seconds

    @classmethod
    def get_pwa_map(cls) -> dict:
        now = time.time()
        if cls._cache and (now - cls._last_scan_time < cls._CACHE_TTL):
            return cls._cache

        app_id_map = {}
        user_home = os.environ.get("USERPROFILE", "")
        candidates = [
            os.path.join(user_home, r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Chrome Apps"),
            os.path.join(user_home, r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Edge Apps"),
        ]

        pattern_ascii = re.compile(rb"--app-id=([a-zA-Z0-9_-]+)")
        pattern_utf16 = re.compile(rb"-\x00-\x00a\x00p\x00p\x00-\x00i\x00d\x00=\x00([a-zA-Z0-9_\x00-]+)")

        for d in candidates:
            if not os.path.exists(d):
                continue
            try:
                for entry in os.listdir(d):
                    if not entry.lower().endswith(".lnk"):
                        continue
                    full_path = os.path.join(d, entry)
                    try:
                        with open(full_path, "rb") as fp:
                            buf = fp.read()

                        app_id = None
                        m_ascii = pattern_ascii.search(buf)
                        if m_ascii:
                            app_id = m_ascii.group(1).decode("ascii", errors="ignore")
                        else:
                            m_utf16 = pattern_utf16.search(buf)
                            if m_utf16:
                                app_id = m_utf16.group(1).decode("utf-16le", errors="ignore").replace("\x00", "")

                        if app_id:
                            app_name = os.path.splitext(entry)[0]
                            app_id_map[app_id.lower()] = {
                                "lnk_path": full_path,
                                "app_name": app_name,
                            }
                    except Exception:
                        continue
            except Exception:
                continue

        cls._cache = app_id_map
        cls._last_scan_time = now
        return app_id_map


def get_app_launch_address(proc) -> tuple[str, bool, str]:
    """
    Resolves the true launch address of a process.
    Only checks Chromium command lines for '--app-id=' to maximize efficiency.
    Returns: (launch_address, is_pwa, pwa_name)
    """
    proc_name_lower = ""
    try:
        proc_name_lower = proc.name().lower()
    except Exception:
        pass

    # Only Chromium/Edge browsers ever host PWAs with --app-id
    cmdline = []
    if proc_name_lower in ("chrome.exe", "msedge.exe", "brave.exe", "opera.exe"):
        try:
            cmdline = proc.cmdline()
        except Exception:
            cmdline = []

    # Check for --app-id=<id> in cmdline
    if cmdline:
        pwa_map = PWAShortcutResolver.get_pwa_map()
        for arg in cmdline:
            if arg.startswith("--app-id="):
                app_id = arg.split("=", 1)[1].strip().lower()
                if app_id in pwa_map:
                    info = pwa_map[app_id]
                    return info["lnk_path"], True, info["app_name"]

    # Fallback to standard exe path
    try:
        exe_path = proc.exe()
        if exe_path:
            return exe_path, False, ""
    except Exception:
        pass

    try:
        name = proc.name()
        return name, False, ""
    except Exception:
        return "Unknown", False, ""


def assign_ring_hierarchy(launch_path: str, active_user: str | None = None, app_name: str = "") -> dict:
    """
    Classifies an app into the 4-tier spatial hierarchy according to its launch address
    and generates structured location keys for the pie-dashboard:
    - Ring 1 (Center Core): Windows Core (e.g. ['Windows', 'System32', 'notepad'])
    - Ring 2 (Drive Space): Non-Windows drive directories (e.g. ['Program Files', 'Google', 'Chrome'])
    - Ring 3 (Users Root): User profile directories (e.g. ['Users', 'Public', 'tool'])
    - Ring 4 (User Subdirectory): Active user subdirectories (e.g. ['Users', 'bhuva', 'AppData', 'YouTube'])
    """
    if not launch_path or launch_path == "Unknown":
        loc_name = app_name or "Unknown"
        return {
            "ring": 2,
            "zone": "Drive Space",
            "location_keys": ["Drive Root", loc_name],
            "sector_path": ["Unknown"],
            "full_address": launch_path or "Unknown",
            "parent_dir": "",
            "is_pwa": False,
        }

    p = os.path.normpath(os.path.abspath(launch_path) if os.path.isabs(launch_path) else launch_path)
    p_lower = p.lower()

    if not active_user:
        active_user = getpass.getuser()

    if not app_name:
        app_name = os.path.splitext(os.path.basename(p))[0]

    # Ring 1: Windows Core, including kernel pseudo-processes with no disk path.
    identity = str(app_name or "").strip().lower()
    basename = os.path.splitext(os.path.basename(p))[0].strip().lower()
    if identity in PSEUDO_OS_IDENTITIES or basename in PSEUDO_OS_IDENTITIES:
        return {
            "ring": 1,
            "zone": "Windows Core",
            "location_keys": ["Windows", app_name or "System"],
            "sector_path": ["Windows"],
            "full_address": p,
            "parent_dir": "",
            "is_pwa": False,
        }

    user_home = os.environ.get("USERPROFILE", f"C:\\Users\\{active_user}")
    users_root = os.path.dirname(user_home).lower()
    win_dir = os.environ.get("SystemRoot", "C:\\Windows").lower()

    is_pwa = p_lower.endswith(".lnk")

    # Ring 1: Windows Core
    if p_lower.startswith(win_dir + "\\") or p_lower == win_dir:
        rel = os.path.relpath(p, win_dir)
        parts = [x for x in rel.split(os.sep) if x]
        if parts and parts[0].lower() == "system32":
            loc_keys = ["Windows", "System32", app_name]
        else:
            loc_keys = ["Windows", app_name]
        return {
            "ring": 1,
            "zone": "Windows Core",
            "location_keys": loc_keys,
            "sector_path": ["Windows"],
            "full_address": p,
            "parent_dir": os.path.dirname(p),
            "is_pwa": is_pwa,
        }

    # Users Directory: Ring 3 & Ring 4
    if p_lower.startswith(users_root + "\\"):
        try:
            rel = os.path.relpath(p, users_root)
            parts = [x for x in rel.split(os.sep) if x]
            profile_name = parts[0] if parts else active_user
            if profile_name.lower() == active_user.lower() and len(parts) > 1:
                subdir = parts[1]
                loc_keys = ["Users", profile_name, subdir, app_name]
                return {
                    "ring": 4,
                    "zone": "User Subdirectory",
                    "location_keys": loc_keys,
                    "sector_path": ["Users", profile_name, subdir],
                    "full_address": p,
                    "parent_dir": os.path.dirname(p),
                    "is_pwa": is_pwa,
                }
            else:
                loc_keys = ["Users", profile_name, app_name]
                return {
                    "ring": 3,
                    "zone": "User Profile",
                    "location_keys": loc_keys,
                    "sector_path": ["Users", profile_name],
                    "full_address": p,
                    "parent_dir": os.path.dirname(p),
                    "is_pwa": is_pwa,
                }
        except Exception:
            return {
                "ring": 3,
                "zone": "User Profile",
                "location_keys": ["Users", active_user, app_name],
                "sector_path": ["Users", active_user],
                "full_address": p,
                "parent_dir": os.path.dirname(p),
                "is_pwa": is_pwa,
            }

    # Ring 2: Drive Non-Windows (Program Files, Games, secondary drives)
    drive, rest = os.path.splitdrive(p)
    parts = [part for part in rest.split(os.sep) if part]
    top_folder = parts[0] if parts else "Drive Root"
    sector = [f"{drive}\\{top_folder}"] if drive else [top_folder]
    if len(parts) > 2 and "program files" in top_folder.lower():
        loc_keys = [top_folder, parts[1], app_name]
    else:
        loc_keys = [top_folder, app_name]

    return {
        "ring": 2,
        "zone": "Drive Space",
        "location_keys": loc_keys,
        "sector_path": sector,
        "full_address": p,
        "parent_dir": os.path.dirname(p),
        "is_pwa": is_pwa,
    }


def scan_user_sectors(active_user: str | None = None) -> dict:
    """
    Dynamically inspects the host filesystem to build the full 4-tier
    Sunburst skeleton matching the sectors available on the user's system.
    100% dynamic: zero hardcoded drives, folders, or usernames.
    """
    if not active_user:
        active_user = getpass.getuser()

    user_home = os.environ.get("USERPROFILE", "")
    if not user_home:
        sys_drive = os.environ.get("SystemDrive", "C:")
        user_home = os.path.join(sys_drive, "Users", active_user)

    users_root = os.path.dirname(user_home) if user_home else os.path.join(os.environ.get("SystemDrive", "C:"), "Users")

    # Ring 3: All user profiles
    profiles = []
    if os.path.exists(users_root):
        try:
            for f in os.listdir(users_root):
                if os.path.isdir(os.path.join(users_root, f)):
                    profiles.append(f)
        except Exception:
            profiles = [active_user, "Public"]
    if not profiles:
        profiles = [active_user]

    # Ring 4: Subdirectories in active user folder
    subdirs = []
    for sd in ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos"]:
        if os.path.exists(os.path.join(user_home, sd)):
            subdirs.append(sd)
    if not subdirs:
        subdirs = ["AppData", "Downloads", "Desktop", "Documents", "Pictures"]

    # Ring 2: Top-level drive folders and mounted partitions
    drive_folders = []
    for env_var, fallback in [("ProgramFiles", "Program Files"), ("ProgramFiles(x86)", "Program Files (x86)"), ("ProgramData", "ProgramData")]:
        val = os.environ.get(env_var)
        if val and os.path.exists(val):
            if val not in drive_folders:
                drive_folders.append(val)
        else:
            sys_drive = os.environ.get("SystemDrive", "C:")
            fallback_path = os.path.join(sys_drive, fallback)
            if os.path.exists(fallback_path) and fallback_path not in drive_folders:
                drive_folders.append(fallback_path)

    # Dynamically detect all active mounted drives
    try:
        sys_drive = os.environ.get("SystemDrive", "C:").upper()
        if HAS_PSUTIL:
            for part in psutil.disk_partitions(all=False):
                mount = part.mountpoint
                if mount and os.path.exists(mount):
                    if not mount.upper().startswith(sys_drive):
                        if mount not in drive_folders:
                            drive_folders.append(mount)
        else:
            for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                root = f"{c}:\\"
                if os.path.exists(root) and not root.upper().startswith(sys_drive):
                    if root not in drive_folders:
                        drive_folders.append(root)
    except Exception:
        pass

    return {
        "ring1_windows": ["Windows"],
        "ring2_drive": drive_folders,
        "ring3_users": profiles,
        "ring4_active_user": {
            "username": active_user,
            "subdirectories": subdirs,
        },
    }


# ---------------------------------------------------------------------------
# File Reach Watcher (Pictures, Documents, Desktop, Downloads)
# ---------------------------------------------------------------------------
class FileReachTracker:
    """
    Watches user sensitive personal folders using watchdog's PollingObserver
    and correlates file modifications/creations with active applications.
    """

    def __init__(self, max_history: int = 60):
        self.max_history = max_history
        self.lock = threading.Lock()
        self.recent_events = deque(maxlen=max_history)
        self.app_file_activity = {}  # app_display_name -> list of recent file events
        self.folder_event_counts = {"Pictures": 0, "Documents": 0, "Desktop": 0, "Downloads": 0}
        self.observer = None
        self.monitored_paths = self.get_personal_directories()

    def get_personal_directories(self) -> list[tuple[str, str]]:
        """
        Discovers valid user personal folders dynamically.
        Reads HKCU User Shell Folders to automatically support:
        - Multi-language Windows (German, French, Spanish, Japanese, Chinese, etc.)
        - OneDrive folder redirection
        - Custom user-moved vault directories
        """
        user_home = os.environ.get("USERPROFILE", "")
        valid = []
        seen_paths = set()

        # 1. Query Windows User Shell Folders registry
        shell_key = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
        shell_mappings = [
            ("Pictures", "My Pictures"),
            ("Documents", "Personal"),
            ("Desktop", "Desktop"),
            ("Downloads", "{374DE290-123F-4565-9164-39C4925E467B}"),
        ]
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, shell_key) as key:
                for cat, reg_val in shell_mappings:
                    try:
                        raw_val, _ = winreg.QueryValueEx(key, reg_val)
                        expanded = os.path.expandvars(raw_val)
                        if os.path.exists(expanded) and expanded.lower() not in seen_paths:
                            seen_paths.add(expanded.lower())
                            valid.append((cat, expanded))
                    except OSError:
                        pass
        except Exception:
            pass

        # 2. Dynamic fallbacks if registry was not accessible
        candidates = [
            ("Pictures", os.path.join(user_home, "Pictures")),
            ("Pictures", os.path.join(user_home, "OneDrive", "Pictures")),
            ("Documents", os.path.join(user_home, "Documents")),
            ("Documents", os.path.join(user_home, "OneDrive", "Documents")),
            ("Desktop", os.path.join(user_home, "Desktop")),
            ("Desktop", os.path.join(user_home, "OneDrive", "Desktop")),
            ("Downloads", os.path.join(user_home, "Downloads")),
        ]
        for cat, p in candidates:
            if os.path.exists(p) and p.lower() not in seen_paths:
                seen_paths.add(p.lower())
                valid.append((cat, p))
        return valid

    def start(self):
        if not self.monitored_paths:
            self.monitored_paths = self.get_personal_directories()

        if HAS_WATCHDOG:
            try:
                self.observer = PollingObserver(timeout=0.25)

                class InternalHandler(FileSystemEventHandler):
                    def __init__(self, tracker, category):
                        self.tracker = tracker
                        self.category = category

                    def on_any_event(self, event):
                        if event.is_directory:
                            return
                        base = os.path.basename(event.src_path)
                        if base.startswith("~$") or base.endswith(".tmp") or base.startswith("."):
                            return
                        self.tracker.record_file_event(self.category, event.event_type.capitalize(), event.src_path)

                for cat, folder_path in self.monitored_paths:
                    try:
                        self.observer.schedule(InternalHandler(self, cat), folder_path, recursive=False)
                    except Exception:
                        pass

                self.observer.start()
                return
            except Exception:
                pass

        # Zero-dependency native fallback: thread polling with os.scandir
        self._running = True
        self._known_files = {}
        for cat, folder in self.monitored_paths:
            try:
                if os.path.isdir(folder):
                    for entry in os.scandir(folder):
                        if entry.is_file(follow_symlinks=False):
                            self._known_files[entry.path] = entry.stat().st_mtime
            except Exception:
                pass

        def _native_poll_loop():
            while getattr(self, "_running", False):
                time.sleep(1.0)
                for cat, folder in self.monitored_paths:
                    try:
                        if not os.path.isdir(folder):
                            continue
                        for entry in os.scandir(folder):
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            base = entry.name
                            if base.startswith("~$") or base.endswith(".tmp") or base.startswith("."):
                                continue
                            p = entry.path
                            mtime = entry.stat().st_mtime
                            if p not in self._known_files:
                                self._known_files[p] = mtime
                                self.record_file_event(cat, "Created", p)
                            elif mtime > self._known_files[p] + 0.1:
                                self._known_files[p] = mtime
                                self.record_file_event(cat, "Modified", p)
                    except Exception:
                        pass

        self._poll_thread = threading.Thread(target=_native_poll_loop, daemon=True)
        self._poll_thread.start()

    def record_file_event(self, folder_category: str, action: str, file_path: str):
        # Determine which process is responsible
        locking = get_processes_locking_file(file_path)
        if locking:
            pid, raw_app = locking[0]
            display_name = raw_app
            process_name = raw_app
        else:
            pid, process_name, display_name = get_foreground_process()

        filename = os.path.basename(file_path)
        record = {
            "timestamp": time.strftime("%H:%M:%S"),
            "folder": folder_category,
            "action": action,
            "filename": filename,
            "filepath": file_path,
            "app_name": display_name,
            "process_name": process_name,
            "pid": pid,
        }

        with self.lock:
            self.recent_events.appendleft(record)
            self.folder_event_counts[folder_category] = self.folder_event_counts.get(folder_category, 0) + 1
            if display_name not in self.app_file_activity:
                self.app_file_activity[display_name] = []
            self.app_file_activity[display_name].append({
                "folder": folder_category,
                "action": action,
                "filename": filename,
                "time": record["timestamp"],
            })
            # Keep per-app history limited
            if len(self.app_file_activity[display_name]) > 10:
                self.app_file_activity[display_name].pop(0)

    def get_summary(self) -> dict:
        with self.lock:
            return {
                "monitored_folders": [f"{cat} ({p})" for cat, p in self.monitored_paths],
                "folder_counts": dict(self.folder_event_counts),
                "recent_events": list(self.recent_events)[:30],
                "app_activity": dict(self.app_file_activity),
            }

    def stop(self):
        self._running = False
        if self.observer:
            try:
                self.observer.stop()
                self.observer.join(timeout=1.0)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Hardware Access Engine (WASAPI + ConsentStore)
# ---------------------------------------------------------------------------
class HardwareAccessChecker:
    def __init__(self):
        self.capabilities = ["microphone", "webcam"]

    def get_wasapi_audio_sessions(self) -> dict:
        sessions_by_pid = {}
        if not HAS_PYCAW:
            return sessions_by_pid
        # Strictly monitor capture (microphone/input) devices only
        try:
            devices = AudioUtilities.GetAllDevices(data_flow=EDataFlow.eCapture.value, device_state=DEVICE_STATE.ACTIVE.value)
            for dev in devices:
                try:
                    mgr = dev.AudioSessionManager
                    if not mgr:
                        continue
                    enum = mgr.GetSessionEnumerator()
                    if not enum:
                        continue
                    for i in range(enum.GetCount()):
                        ctl = enum.GetSession(i)
                        if not ctl:
                            continue
                        ctl2 = ctl.QueryInterface(IAudioSessionControl2)
                        sess = AudioSession(ctl2)
                        pid = sess.ProcessId
                        if pid != 0:
                            # State 1 = AudioSessionStateActive
                            is_active = (sess.State == 1)
                            if pid not in sessions_by_pid or is_active:
                                sessions_by_pid[pid] = {
                                    "active": is_active,
                                    "state": sess.State,
                                    "device": dev.FriendlyName,
                                    "is_capture": True,
                                }
                except Exception:
                    continue
        except Exception:
            pass
        return sessions_by_pid

    def _decode_app_identity(self, raw_key_name: str) -> str:
        if raw_key_name.startswith("C:#") or (len(raw_key_name) > 2 and raw_key_name[1] == ":" and "#" in raw_key_name):
            return raw_key_name.replace("#", "\\")
        return raw_key_name

    def scan_consent_store(self, capability: str) -> list[dict]:
        import winreg
        results = []
        base_path = f"{CONSENT_STORE_BASE}\\{capability}"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base_path) as cap_key:
                num_subkeys, _, _ = winreg.QueryInfoKey(cap_key)
                for i in range(num_subkeys):
                    app_key_name = winreg.EnumKey(cap_key, i)
                    if app_key_name == "NonPackaged":
                        non_pkg_path = f"{base_path}\\NonPackaged"
                        try:
                            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, non_pkg_path) as non_pkg_key:
                                np_count, _, _ = winreg.QueryInfoKey(non_pkg_key)
                                for j in range(np_count):
                                    sub_name = winreg.EnumKey(non_pkg_key, j)
                                    decoded_path = self._decode_app_identity(sub_name)
                                    try:
                                        with winreg.OpenKey(non_pkg_key, sub_name) as entry_key:
                                            entry = self._parse_registry_entry(capability, decoded_path, entry_key, is_packaged=False)
                                            if entry:
                                                results.append(entry)
                                    except OSError:
                                        pass
                        except OSError:
                            pass
                        continue
                    try:
                        with winreg.OpenKey(cap_key, app_key_name) as entry_key:
                            entry = self._parse_registry_entry(capability, app_key_name, entry_key, is_packaged=True)
                            if entry:
                                results.append(entry)
                    except OSError:
                        pass
        except OSError:
            pass
        return results

    def _parse_registry_entry(self, capability: str, app_identity: str, reg_key, is_packaged: bool) -> dict | None:
        import winreg
        try:
            start_val, _ = winreg.QueryValueEx(reg_key, "LastUsedTimeStart")
            stop_val, _ = winreg.QueryValueEx(reg_key, "LastUsedTimeStop")
            start = int(start_val)
            stop = int(stop_val)
        except (OSError, ValueError, TypeError):
            return None
        is_active = (start > 0) and (stop == 0 or stop < start)
        app_name = os.path.basename(app_identity) if not is_packaged else app_identity.split("_")[0]
        return {
            "capability": capability,
            "app_name": app_name,
            "identity": app_identity,
            "is_packaged": is_packaged,
            "is_active": is_active,
            "last_start_time": filetime_to_datetime(start),
            "last_stop_time": filetime_to_datetime(stop) if stop > 0 else "CURRENTLY STREAMING",
        }

    def get_all_hardware_and_file_usage(self, file_tracker: FileReachTracker = None) -> dict:
        wasapi_sessions = self.get_wasapi_audio_sessions()
        reg_mic_entries = self.scan_consent_store("microphone")
        reg_cam_entries = self.scan_consent_store("webcam")

        reg_mic_map = {e["identity"].lower(): e for e in reg_mic_entries}
        reg_cam_map = {e["identity"].lower(): e for e in reg_cam_entries}

        # Get file tracking summary
        file_summary = file_tracker.get_summary() if file_tracker else {"monitored_folders": [], "folder_counts": {}, "recent_events": [], "app_activity": {}}
        app_file_map = file_summary.get("app_activity", {})

        apps_by_name = {}

        for p in get_process_iter():
            try:
                proc_name = (p.info.get("name") or "").strip()
                exe_path = (p.info.get("exe") or "").strip()
                pid = p.info.get("pid")
                if not proc_name or not pid or pid == 0:
                    continue

                exe_lower = exe_path.lower()
                win_sys32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32").lower()
                if win_sys32 in exe_lower and proc_name.lower() in [
                    "svchost.exe", "lsass.exe", "csrss.exe", "services.exe", "wininit.exe", "smss.exe"
                ]:
                    continue

                # Resolve true launch address & spatial hierarchy
                launch_addr, is_pwa, pwa_name = get_app_launch_address(p)
                display_name = pwa_name if (is_pwa and pwa_name) else get_app_display_name(exe_path, proc_name)
                spatial = assign_ring_hierarchy(launch_addr, app_name=display_name)

                wasapi_info = wasapi_sessions.get(pid) or {}
                wasapi_mic_active = bool(wasapi_info.get("active", False) and wasapi_info.get("is_capture", False))
                wasapi_has_session = wasapi_info.get("state") is not None

                reg_mic = reg_mic_map.get(exe_lower) or reg_mic_map.get(proc_name.lower())
                reg_cam = reg_cam_map.get(exe_lower) or reg_cam_map.get(proc_name.lower())

                reg_mic_active = bool(reg_mic.get("is_active")) if reg_mic else False
                reg_cam_active = bool(reg_cam.get("is_active")) if reg_cam else False
                mic_active = wasapi_mic_active or reg_mic_active
                cam_active = reg_cam_active

                mic_last_start = reg_mic["last_start_time"] if reg_mic else ("WASAPI Session" if wasapi_has_session else None)
                cam_last_start = reg_cam["last_start_time"] if reg_cam else None

                # File reach for this app
                file_events = app_file_map.get(display_name) or app_file_map.get(proc_name) or []
                folders_touched = list(set(e["folder"] for e in file_events))

                group_key = display_name if display_name else proc_name
                if group_key not in apps_by_name:
                    apps_by_name[group_key] = {
                        "app_name": group_key,
                        "process_name": proc_name,
                        "path": launch_addr,
                        "exe_path": exe_path,
                        "spatial": spatial,
                        "pids": [pid],
                        "primary_pid": pid,
                        "is_running": True,
                        "microphone": {
                            "active": mic_active,
                            "last_start": mic_last_start,
                            "wasapi_session": wasapi_has_session,
                        },
                        "webcam": {
                            "active": cam_active,
                            "last_start": cam_last_start,
                        },
                        "file_reach": {
                            "folders_touched": folders_touched,
                            "recent_files": file_events,
                            "has_access": len(folders_touched) > 0,
                        },
                    }
                else:
                    existing = apps_by_name[group_key]
                    existing["pids"].append(pid)
                    if mic_active:
                        existing["microphone"]["active"] = True
                    if cam_active:
                        existing["webcam"]["active"] = True
                    if wasapi_has_session:
                        existing["microphone"]["wasapi_session"] = True
                    if folders_touched:
                        for f_touched in folders_touched:
                            if f_touched not in existing["file_reach"]["folders_touched"]:
                                existing["file_reach"]["folders_touched"].append(f_touched)
                        existing["file_reach"]["has_access"] = True

            except Exception:
                continue

        # Stopped apps from registry
        for reg_map, cap_name in [(reg_mic_map, "microphone"), (reg_cam_map, "webcam")]:
            for ident_lower, reg_item in reg_map.items():
                ident = reg_item["identity"]
                display_name = get_app_display_name(ident if not reg_item["is_packaged"] else "", reg_item["app_name"])
                if display_name not in apps_by_name:
                    prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
                    spatial_path = ident if not reg_item["is_packaged"] else os.path.join(prog_files, "WindowsApps", ident)
                    spatial = assign_ring_hierarchy(spatial_path, app_name=display_name)
                    apps_by_name[display_name] = {
                        "app_name": display_name,
                        "process_name": reg_item["app_name"],
                        "path": ident,
                        "exe_path": ident,
                        "spatial": spatial,
                        "pids": [],
                        "primary_pid": None,
                        "is_running": False,
                        "microphone": {
                            "active": reg_item["is_active"] if cap_name == "microphone" else False,
                            "last_start": reg_item["last_start_time"] if cap_name == "microphone" else None,
                            "wasapi_session": False,
                        },
                        "webcam": {
                            "active": reg_item["is_active"] if cap_name == "webcam" else False,
                            "last_start": reg_item["last_start_time"] if cap_name == "webcam" else None,
                        },
                        "file_reach": {
                            "folders_touched": [],
                            "recent_files": [],
                            "has_access": False,
                        },
                    }

        apps_list = list(apps_by_name.values())

        # Sort priority:
        # 1. Live hardware active
        # 2. Reaching into sensitive folders
        # 3. Active WASAPI sessions
        # 4. Running apps
        def sort_priority(item):
            mic_data = item.get("microphone") or {}
            cam_data = item.get("webcam") or {}
            file_data = item.get("file_reach") or {}
            score = 0
            if mic_data.get("active") or cam_data.get("active"):
                score += 100
            if file_data.get("has_access"):
                score += 70
            if mic_data.get("wasapi_session"):
                score += 40
            if mic_data.get("last_start") or cam_data.get("last_start"):
                score += 20
            if item.get("is_running"):
                score += 10
            return score

        apps_list.sort(key=sort_priority, reverse=True)

        active_count = sum(
            1 for a in apps_list
            if (a.get("microphone") or {}).get("active") or (a.get("webcam") or {}).get("active")
        )
        running_count = sum(1 for a in apps_list if a.get("is_running"))
        file_reach_count = sum(1 for a in apps_list if (a.get("file_reach") or {}).get("has_access"))

        meta_dict = {
            "version": "1.0.0",
            "timestamp": time.time(),
            "scan_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "refresh_interval_sec": 1.5,
            "active_user": getpass.getuser(),
            "total_apps_tracked": len(apps_list),
            "running_apps_count": running_count,
            "active_hardware_count": active_count,
            "apps_with_file_reach": file_reach_count,
        }

        return {
            "meta": meta_dict,
            "timestamp": meta_dict["timestamp"],
            "scan_time": meta_dict["scan_time"],
            "refresh_interval_sec": 1.5,
            "total_apps_tracked": len(apps_list),
            "active_hardware_count": active_count,
            "running_apps_count": running_count,
            "apps_with_file_reach": file_reach_count,
            "skeleton": scan_user_sectors(),
            "file_summary": file_summary,
            "apps": apps_list,
        }


def run_daemon(interval_sec: float = 1.5, is_background: bool = False):
    existing_pid = get_running_daemon_pid()
    if existing_pid:
        if is_background:
            sys.exit(0)
        else:
            print(f"[*] Found existing daemon (PID: {existing_pid}). Taking over as interactive session...")
            try:
                terminate_by_pid(existing_pid)
                time.sleep(0.3)
            except Exception:
                pass

    try:
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass

    # Start file reach tracker
    file_tracker = FileReachTracker()
    file_tracker.start()

    checker = HardwareAccessChecker()
    print(f"\n[*] Observatory: acquired.py daemon running (PID: {os.getpid()})")
    print(f"[*] Hardware: WASAPI + ConsentStore Active")
    print(f"[*] File Reach: Watching Pictures, Documents, Desktop, Downloads")
    print(f"[*] State file target: {STATE_FILE}")
    print(f"[*] Press Ctrl+C to stop.\n" + "-" * 85)

    iteration = 0
    try:
        while True:
            iteration += 1
            data = checker.get_all_hardware_and_file_usage(file_tracker)

            temp_file = f"{STATE_FILE}.tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_file, STATE_FILE)

            active_hw = [
                f"{a['app_name']}"
                for a in data["apps"]
                if (a.get("microphone") or {}).get("active") or (a.get("webcam") or {}).get("active")
            ]
            file_apps = [
                f"{a['app_name']} -> {','.join((a.get('file_reach') or {}).get('folders_touched', []))}"
                for a in data["apps"]
                if (a.get("file_reach") or {}).get("has_access")
            ]

            status_parts = []
            if active_hw:
                status_parts.append(f"HW ACTIVE: {', '.join(active_hw)}")
            if file_apps:
                status_parts.append(f"FILES: {', '.join(file_apps[:2])}")
            if not status_parts:
                status_parts.append("Quiet")

            print(f"[{data['scan_time']}] Tick #{iteration:<3} | Tracked: {data['total_apps_tracked']:<2} | Running: {data['running_apps_count']:<2} | [{' | '.join(status_parts)}]")

            time.sleep(interval_sec)

    except KeyboardInterrupt:
        print("\n[*] acquired.py daemon stopped gracefully.")
    except Exception as e:
        print(f"\n[!] Unexpected error in daemon: {e}")
        traceback.print_exc()
        if not is_background:
            input("\nPress Enter to exit...")
    finally:
        file_tracker.stop()
        if os.path.exists(PID_FILE):
            try:
                os.remove(PID_FILE)
            except Exception:
                pass


if __name__ == "__main__":
    is_bg = "--background" in sys.argv
    interval = 1.5
    for arg in sys.argv[1:]:
        if arg.replace(".", "", 1).isdigit():
            interval = float(arg)
            break

    try:
        run_daemon(interval_sec=interval, is_background=is_bg)
    except Exception as e:
        print(f"\n[!] Fatal error: {e}")
        traceback.print_exc()
        if not is_bg:
            input("\nPress Enter to exit...")
