# Open Source References & Engineering Attributions

This document records the external open-source projects on GitHub that were analyzed, adapted, and referenced to engineer the backend telemetry and spatial placement engines in **Observatory**.

---

## 1. PrivacyDot
- **Repository:** [farflashgroup/PrivacyDot](https://github.com/farflashgroup/PrivacyDot)
- **Author / Organization:** Far Flash Group
- **License:** MIT License
- **Key Concepts Inspected:**
  - `RegistryUsageReader.cs`: Enumerating the Windows `CapabilityAccessManager\ConsentStore` registry hierarchy for `microphone` and `webcam`.
  - `RegistryUsageParser.cs`: The exact boolean condition determining active live streaming: `start > 0 && (stop == 0 || stop < start)`.
  - `AppNameResolver.cs`: Sanitizing Windows registry keys by restoring `#` to `\` to recover full executable paths for Win32 `NonPackaged` applications.
- **How Observatory Uses It:**
  - Re-implemented natively in pure Python via `winreg` and `ctypes` in `acquired.py` (`HardwareAccessChecker`), delivering zero-overhead, driverless detection of microphone and webcam access across both classic Win32 programs and UWP apps.

---

## 2. pycaw (Python Core Audio Windows Library)
- **Repository:** [AndreMiras/pycaw](https://github.com/AndreMiras/pycaw)
- **Author / Maintainer:** André Miras
- **License:** MIT License
- **Key Concepts Inspected:**
  - COM/WASAPI interfaces: `IAudioSessionManager2`, `IAudioSessionControl2`, and `IAudioSessionEnumerator`.
  - Capturing active audio sessions specifically bound to input data flow (`eCapture`).
- **How Observatory Uses It:**
  - Directly queries WASAPI audio endpoints in `acquired.py` to identify the exact Process ID (PID) currently holding an open microphone capture stream.

---

## 3. System Informer (formerly Process Hacker)
- **Repository:** [winsiderss/systeminformer](https://github.com/winsiderss/systeminformer)
- **Author / Maintainers:** Winsiders Network & Process Hacker Team (wj32, dmex, etc.)
- **License:** GNU General Public License v3 (GPLv3)
- **Key Concepts Inspected:**
  - `phlib/nativetoken.c`:
    - `PhGetTokenIntegrityLevelRID`: Reading `TokenIntegrityLevel` (Token Information Class 25) using `OpenProcessToken` and `GetTokenInformation`.
    - Mandatory Integrity Label RIDs:
      - `0x0000`: Untrusted
      - `0x1000` (`SECURITY_MANDATORY_LOW_RID`): Low Integrity (AppContainer / Sandboxed)
      - `0x2000` (`SECURITY_MANDATORY_MEDIUM_RID`): Standard User Space
      - `0x3000` (`SECURITY_MANDATORY_HIGH_RID`): Elevated / Administrator
      - `0x4000` (`SECURITY_MANDATORY_SYSTEM_RID`): Core OS / Kernel / SYSTEM
- **How Observatory Uses It:**
  - Re-implemented via `ctypes.windll.advapi32` in `acquired.py` (`TokenIntegrityChecker`) to classify running processes by Windows security integrity level without external dependencies.

---

## 4. Watchdog
- **Repository:** [gorakhargosh/watchdog](https://github.com/gorakhargosh/watchdog)
- **Author / Maintainers:** Yesudeep Mangalapilly, Thomas Heller, Will McGugan, Ryan Kelly, Thomas Amland, Mickaël Schoentgen
- **License:** Apache License 2.0
- **Key Concepts Inspected:**
  - `src/watchdog/observers/winapi.py`: Win32 `ReadDirectoryChangesW` and `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS` using pure Python `ctypes`.
- **How Observatory Uses It:**
  - Provides event-driven filesystem observation over personal sensitive directories (`Pictures`, `Documents`, `Desktop`, `Downloads`) combined with Windows Restart Manager (`rstrtmgr.dll`) to detect applications touching user files.

---

## 5. Simplewall
- **Repository:** [henrypp/simplewall](https://github.com/henrypp/simplewall)
- **Author / Maintainer:** Henry++ (henrypp)
- **License:** GNU General Public License v3 (GPLv3)
- **Key Concepts Inspected:**
  - `bin/profile_internal.xml`: Structured definitions distinguishing Windows core services (DNS, DHCP, mDNS, NetBIOS) from user telemetry and third-party network egress.
- **How Observatory Uses It:**
  - Serves as the reference taxonomy for differentiating OS-level kernel/network traffic from third-party application activity.

---

## 6. Portmaster
- **Repository:** [safing/portmaster](https://github.com/safing/portmaster)
- **Author / Organization:** Safing ICS Technologies
- **License:** GNU Affero General Public License v3 (AGPLv3)
- **Key Concepts Inspected:**
  - Socket-to-process correlation and Autonomous System Number (ASN) categorization for privacy intelligence.
- **How Observatory Uses It:**
  - Informs the data taxonomy for mapping applications to domain and provider scopes in the broader Observatory privacy architecture.

---

## Summary Matrix

| Reference Tool | Primary Language | What Observatory Borrowed & Adapted |
| :--- | :--- | :--- |
| **PrivacyDot** | C# | `ConsentStore` Registry active streaming logic (`start > 0 && (stop == 0 \|\| stop < start)`) |
| **pycaw** | Python | WASAPI Core Audio session query patterns for active microphone sessions |
| **System Informer** | C | Win32 `GetTokenInformation` Integrity RIDs (`0x1000` to `0x4000`) |
| **Watchdog** | Python | Non-blocking directory change notifications over personal directories |
| **Simplewall** | C / XML | System service vs. user process classification taxonomy |
| **Portmaster** | Go | Process-to-destination privacy attribution model |
