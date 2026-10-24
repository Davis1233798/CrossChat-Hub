using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Web.Script.Serialization;

// Fixed installed LINE path only. Authenticode + native metadata, no chat/UI.
internal static class LineWitness {
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a,IntPtr b);
  [DllImport("wintrust.dll",ExactSpelling=true,PreserveSig=true)] static extern int WinVerifyTrust(IntPtr hwnd,ref Guid action,ref TrustData data);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct TrustFile { public uint Size; public IntPtr Path,File,Subject; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct TrustData {
    public uint Size;public IntPtr Policy,Sip;public uint UI,Revocation,Union;public IntPtr File;public uint StateAction;public IntPtr State;public IntPtr Url;public uint Flags,Context;public IntPtr SignatureSettings;
  }
  public static string FixedPath { get {return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"LINE","bin","current","LINE.exe");} }
  static string Hash(string path) { using(var input=File.OpenRead(path))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant(); }
  static string Verify() {
    string path=FixedPath;
    var file=new TrustFile {Size=(uint)Marshal.SizeOf(typeof(TrustFile)),Path=Marshal.StringToCoTaskMemUni(path)};
    IntPtr native=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile)));Marshal.StructureToPtr(file,native,false);
    var trust=new TrustData {Size=(uint)Marshal.SizeOf(typeof(TrustData)),UI=2,Revocation=1,Union=1,File=native,StateAction=1,Flags=0x80};
    var action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    try {
      int code=WinVerifyTrust(new IntPtr(-1),ref action,ref trust);
      if(code!=0)throw new Exception("LINE Authenticode trust rejected: "+code);
      using(var cert=new X509Certificate2(X509Certificate.CreateFromSignedFile(path))) {
        string publisher=cert.GetNameInfo(X509NameType.SimpleName,false);
        // Observed valid installed signature, not an assumed publisher alias.
        if(publisher!="LY Corporation")throw new Exception("Unexpected LINE publisher");
        return publisher;
      }
    } finally { trust.StateAction=2;WinVerifyTrust(new IntPtr(-1),ref action,ref trust);Marshal.FreeHGlobal(native);Marshal.FreeCoTaskMem(file.Path); }
  }
  public static Dictionary<string,object> Capture() {
    string publisher=Verify();Dictionary<string,object> found=null;
    foreach(var process in Process.GetProcessesByName("LINE"))using(process) {
      try {
        if(!String.Equals(process.MainModule.FileName,FixedPath,StringComparison.OrdinalIgnoreCase))continue;
        IntPtr hwnd=process.MainWindowHandle;if(hwnd==IntPtr.Zero)continue;
        uint pid;GetWindowThreadProcessId(hwnd,out pid);
        if(pid!=(uint)process.Id || GetParent(hwnd)!=IntPtr.Zero || !IsWindowVisible(hwnd)||IsIconic(hwnd)||!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(hwnd),new IntPtr(-4)))continue;
        if(found!=null)throw new Exception("Multiple eligible LINE main HWNDs");
        found=new Dictionary<string,object> { {"pid",process.Id},{"startTicks",process.StartTime.ToUniversalTime().Ticks.ToString()},{"hwnd",hwnd.ToInt64().ToString()},{"path",FixedPath},{"publisher",publisher},{"sha256",Hash(FixedPath)},{"dpiContext","context-4"} };
      } catch(System.ComponentModel.Win32Exception) {} catch(InvalidOperationException) {}
    }
    if(found==null)throw new Exception("No unique visible installed PMv2 LINE main window");return found;
  }
  public static Process Validate(Dictionary<string,object> witness,out IntPtr window) {
    var current=Capture();
    foreach(string key in new [] {"pid","startTicks","hwnd","path","publisher","sha256","dpiContext"})
      if(!witness.ContainsKey(key)||Convert.ToString(witness[key])!=Convert.ToString(current[key]))throw new Exception("LINE witness changed: "+key);
    window=new IntPtr(long.Parse((string)current["hwnd"]));return Process.GetProcessById(Convert.ToInt32(current["pid"]));
  }
  static int Main(string[] args) {
    if(args.Length!=0)return 2;
    try {Console.WriteLine(new JavaScriptSerializer().Serialize(Capture()));return 0;}
    catch(Exception ex){Console.Error.WriteLine(ex.Message);return 1;}
  }
}
