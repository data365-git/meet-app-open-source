# Deliver a REAL Ctrl+Shift+9 to the fake-Meet Chromium window.
#
# WScript.SendKeys (the original approach) silently fails whenever another
# window holds the foreground: AppActivate reports success, the keystroke lands
# somewhere else, and the proof reads as "the recorder never opened" — a product
# failure that never happened. This uses the Win32 path instead: find the window
# by title, force it to the foreground (attaching to the foreground thread's
# input queue, which is what Windows requires before it will honour
# SetForegroundWindow), then synthesise the chord with SendInput-style keybd_event.
param([string]$TitlePart = "Fake Meet")

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

$found = [IntPtr]::Zero
$cb = [Win32+EnumWindowsProc]{
  param($h, $l)
  if ([Win32]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win32]::GetWindowText($h, $sb, $sb.Capacity)
    if ($sb.ToString() -like "*$TitlePart*") { $script:found = $h; return $false }
  }
  return $true
}
[void][Win32]::EnumWindows($cb, [IntPtr]::Zero)

if ($found -eq [IntPtr]::Zero) { Write-Output "no-window"; exit 1 }

# Windows refuses SetForegroundWindow unless the calling thread owns the current
# foreground or has produced recent input. Synthesising an ALT tap first is the
# documented way to claim that "recent input" status from an automation context.
$VK_MENU = 0x12
[Win32]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
[Win32]::keybd_event($VK_MENU, 0, 0x0002, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120

$fg = [Win32]::GetForegroundWindow()
$fgThread = [Win32]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$me = [Win32]::GetCurrentThreadId()
[void][Win32]::AttachThreadInput($me, $fgThread, $true)
[void][Win32]::SetForegroundWindow($found)
[void][Win32]::AttachThreadInput($me, $fgThread, $false)
Start-Sleep -Milliseconds 600

$VK_CONTROL = 0x11; $VK_SHIFT = 0x10; $VK_9 = 0x39; $KEYUP = 0x0002
[Win32]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero)
[Win32]::keybd_event($VK_SHIFT, 0, 0, [UIntPtr]::Zero)
[Win32]::keybd_event($VK_9, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Win32]::keybd_event($VK_9, 0, $KEYUP, [UIntPtr]::Zero)
[Win32]::keybd_event($VK_SHIFT, 0, $KEYUP, [UIntPtr]::Zero)
[Win32]::keybd_event($VK_CONTROL, 0, $KEYUP, [UIntPtr]::Zero)

$now = [Win32]::GetForegroundWindow()
if ($now -eq $found) { Write-Output "sent-foreground-ok" } else { Write-Output "sent-but-not-foreground" }
