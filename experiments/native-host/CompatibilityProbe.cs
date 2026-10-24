using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// Read-only process/window compatibility metadata. No window titles, chat text,
// accounts, input, launch, SetParent, style/position mutation or termination.
internal static class CompatibilityProbe {
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a,IntPtr b);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  static string Context(IntPtr hwnd) {
    IntPtr context=GetWindowDpiAwarenessContext(hwnd);
    for(int i=1;i<=5;i++)if(AreDpiAwarenessContextsEqual(context,new IntPtr(-i)))return "context-"+i;
    return "unknown";
  }
  static int Main(string[] args) {
    if(args.Length!=0)return 2;
    var records=new List<object>();
    foreach(var process in Process.GetProcesses())using(process) {
      if(process.ProcessName!="LINE" && process.ProcessName!="electron" && process.ProcessName!="HubBroker")continue;
      try {
        string executable=process.MainModule.FileName;
        // Only native LINE and this checkout's Electron/broker metadata.
        bool line=process.ProcessName=="LINE" && Path.GetFileName(executable).Equals("LINE.exe",StringComparison.OrdinalIgnoreCase);
        string repo=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"../../.."));
        if(!line && !executable.StartsWith(repo+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))continue;
        long start=process.StartTime.ToUniversalTime().Ticks;
        IntPtr hwnd=process.MainWindowHandle;
        if(hwnd==IntPtr.Zero)continue;
        uint owner; GetWindowThreadProcessId(hwnd,out owner);
        if(!IsWindow(hwnd)||owner!=(uint)process.Id||process.HasExited||process.StartTime.ToUniversalTime().Ticks!=start)continue;
        records.Add(new { kind=line?"line":"owned-repo-host",pid=process.Id,startTicks=start.ToString(),path=executable,hwnd=hwnd.ToInt64().ToString(),hwndOwnerPid=owner,parent=GetParent(hwnd).ToInt64().ToString(),root=GetAncestor(hwnd,2).ToInt64().ToString(),visible=IsWindowVisible(hwnd),minimized=IsIconic(hwnd),dpiContext=Context(hwnd),dpi=GetDpiForWindow(hwnd) });
      } catch(System.ComponentModel.Win32Exception) {} catch(InvalidOperationException) {}
    }
    Console.WriteLine(new JavaScriptSerializer().Serialize(records));return 0;
  }
}
