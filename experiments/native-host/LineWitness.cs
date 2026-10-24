using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Web.Script.Serialization;

// Fixed installed LINE path only. Authenticode + native metadata, no chat/UI.
internal static class LineWitness {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=32768,RecursionLimit=8};
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
  static List<Dictionary<string,object>> CaptureCandidates() {
    string publisher=Verify();var found=new List<Dictionary<string,object>>();
    foreach(var process in Process.GetProcessesByName("LINE"))using(process) {
      try {
        if(!String.Equals(process.MainModule.FileName,FixedPath,StringComparison.OrdinalIgnoreCase))continue;
        IntPtr hwnd=process.MainWindowHandle;if(hwnd==IntPtr.Zero)continue;
        uint pid;GetWindowThreadProcessId(hwnd,out pid);
        if(pid!=(uint)process.Id || GetParent(hwnd)!=IntPtr.Zero || !IsWindowVisible(hwnd)||IsIconic(hwnd)||!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(hwnd),new IntPtr(-4)))continue;
        found.Add(new Dictionary<string,object> { {"pid",process.Id},{"startTicks",process.StartTime.ToUniversalTime().Ticks.ToString()},{"hwnd",hwnd.ToInt64().ToString()},{"path",FixedPath},{"publisher",publisher},{"sha256",Hash(FixedPath)},{"dpiContext","context-4"} });
        if(found.Count>12)throw new Exception("Too many eligible LINE windows");
      } catch(System.ComponentModel.Win32Exception) {} catch(InvalidOperationException) {}
    }
    return found;
  }
  public static Dictionary<string,object> Capture() {
    var found=CaptureCandidates();if(found.Count!=1)throw new Exception(found.Count==0?"No eligible visible installed LINE main window":"Multiple eligible LINE main HWNDs");return found[0];
  }
  public static Process Validate(Dictionary<string,object> witness,out IntPtr window) {
    var current=Capture();
    foreach(string key in new [] {"pid","startTicks","hwnd","path","publisher","sha256","dpiContext"})
      if(!witness.ContainsKey(key)||Convert.ToString(witness[key])!=Convert.ToString(current[key]))throw new Exception("LINE witness changed: "+key);
    window=new IntPtr(long.Parse((string)current["hwnd"]));return Process.GetProcessById(Convert.ToInt32(current["pid"]));
  }
  static int Main(string[] args) {
    if(args.Length==1&&args[0]=="--self-test") {
      try {
        var probe=Json.DeserializeObject(Json.Serialize(new {v=1,type="ready",protocol=1})) as Dictionary<string,object>;
        if(probe==null||Convert.ToInt32(probe["v"])!=1||Convert.ToInt32(probe["protocol"])!=1)return 1;
        Console.WriteLine(Json.Serialize(new {ok=true,protocol=1,runtime=Environment.Version.ToString()}));return 0;
      } catch { return 1; }
    }
    if(args.Length==2&&args[0]=="--protocol"&&System.Text.RegularExpressions.Regex.IsMatch(args[1],"^[a-f0-9]{48}$"))return ProtocolMain(args[1]);
    if(args.Length!=0)return 2;
    try {Console.WriteLine(new JavaScriptSerializer().Serialize(Capture()));return 0;}
    catch(Exception ex){Console.Error.WriteLine(ex.Message);return 1;}
  }
  static string ReadBoundedLine() {
    var text=new StringBuilder();int value;
    while((value=Console.In.Read())!=-1&&value!='\n') {if(text.Length>=32768)throw new Exception("request-limit");if(value!='\r')text.Append((char)value);}
    if(value==-1&&text.Length==0)return null;return text.ToString();
  }
  static bool Same(Dictionary<string,object> a,Dictionary<string,object> b) {
    foreach(string key in new [] {"pid","startTicks","hwnd","path","publisher","sha256","dpiContext"})
      if(!a.ContainsKey(key)||!b.ContainsKey(key)||!String.Equals(Convert.ToString(a[key]),Convert.ToString(b[key]),StringComparison.OrdinalIgnoreCase))return false;
    return true;
  }
  static int ProtocolMain(string nonce) {
    Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false),false));
    Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)){AutoFlush=true});
    try {
      Console.WriteLine(Json.Serialize(new {v=1,type="ready",nonce}));
      string line=ReadBoundedLine();if(line==null)return 2;
      var request=Json.DeserializeObject(line) as Dictionary<string,object>;
      if(request==null||!(request.ContainsKey("v")&&request["v"] is int&&(int)request["v"]==1)||
         !(request["id"] is string)||((string)request["id"]).Length>64||request["nonce"] as string!=nonce)throw new Exception("invalid-request");
      string op=request["op"] as string;object data;
      if(op=="list-candidates") {
        if(request.Count!=4||request.Keys.Any(k=>!new [] {"v","id","nonce","op"}.Contains(k)))throw new Exception("invalid-request");data=new {candidates=CaptureCandidates()};
      } else if(op=="validate-witness") {
        if(request.Count!=5||request.Keys.Any(k=>!new [] {"v","id","nonce","op","witness"}.Contains(k))||!(request["witness"] is Dictionary<string,object>))throw new Exception("invalid-request");
        var expected=(Dictionary<string,object>)request["witness"];var current=CaptureCandidates();
        if(current.Count(x=>Same(expected,x))!=1)throw new Exception("witness-changed");
        data=new {valid=true,witness=current.First(x=>Same(expected,x))};
      } else throw new Exception("invalid-request");
      Console.WriteLine(Json.Serialize(new {v=1,id=request["id"],nonce,ok=true,data}));return 0;
    } catch { return 1; }
  }
}
