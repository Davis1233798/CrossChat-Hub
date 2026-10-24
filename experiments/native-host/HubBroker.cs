using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Developer study: receives ONLY the launching Hub HWND over private stdin.
// It has no socket, arbitrary binary launch or existing-chat attach interface.
internal static class HubBroker {
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetStyle(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetStyle(IntPtr window, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
  [StructLayout(LayoutKind.Sequential)] struct Placement { public int Length, Flags, ShowCmd; public Point Min, Max; public Rect Normal; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  static JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=4096, RecursionLimit=8 };
  static string nonce, resultPath, mode, injection;
  static Process controller, fixture; static long controllerStart, fixtureStart;
  static IntPtr hub, chat, hubStyle, chatStyle, chatParent, hubParent; static Placement chatPlacement,hubPlacement;
  static bool hubChanged,chatChanged,hubVisible,hubRestored,rollbackAttempted,rollbackVerified;
  static readonly List<string> rollbackOrder=new List<string>();
  static Form root; static Panel pane; static Label status;
  static bool attached, finish, closingRequested, resized, rootSurvived, chatSurvived, chatRestored, chatClosed, controllerExited, dpiEqual;
  static string error;
  static void Trace(string stage) { File.AppendAllText(resultPath+".trace",DateTime.UtcNow.ToString("O")+" "+stage+Environment.NewLine); }
  static void Emit(string type, params object[] fields) {
    var record=new Dictionary<string,object> { {"v",1},{"nonce",nonce},{"type",type} };
    for(int i=0;i<fields.Length;i+=2)record[(string)fields[i]]=fields[i+1];
    try { Console.WriteLine(json.Serialize(record)); Console.Out.Flush(); } catch(IOException) {}
  }
  static bool Alive(Process process,long start,IntPtr window) {
    uint pid; return process!=null && !process.HasExited && process.StartTime.ToUniversalTime().Ticks==start && IsWindow(window) && GetWindowThreadProcessId(window,out pid)!=0 && pid==(uint)process.Id;
  }
  static Placement PlacementOf(IntPtr hwnd) { var p=new Placement { Length=Marshal.SizeOf(typeof(Placement)) }; if(!GetWindowPlacement(hwnd,ref p))throw new Exception("Cannot save fixture placement"); return p; }
  static void Layout() {
    if(!attached || finish || !Alive(controller,controllerStart,hub) || !Alive(fixture,fixtureStart,chat))return;
    // GetClientRect and MoveWindow both use the native physical coordinate
    // space of this PerMonitor process. Electron handles its own child DIP UI.
    Rect r; GetClientRect(pane.Handle,out r); int width=r.Right-r.Left,height=r.Bottom-r.Top;
    int left=Math.Max(1,width-360);
    if(!MoveWindow(hub,0,0,left,height,true)||!MoveWindow(chat,left,0,Math.Max(1,width-left),height,true))throw new Exception("Native layout failed");
  }
  static void RestoreFixture() {
    chatSurvived=Alive(fixture,fixtureStart,chat);
    if(!chatSurvived)return;
    SetParent(chat,chatParent); SetStyle(chat,-16,chatStyle); SetWindowPlacement(chat,ref chatPlacement);
    var actual=PlacementOf(chat);
    chatRestored=GetParent(chat)==chatParent && GetStyle(chat,-16)==chatStyle && actual.Normal.Equals(chatPlacement.Normal) && actual.ShowCmd==chatPlacement.ShowCmd && IsWindowVisible(chat);
    if(chatRestored) { fixture.CloseMainWindow(); chatClosed=fixture.WaitForExit(5000); }
  }
  static bool RestoreHub() {
    if(!Alive(controller,controllerStart,hub))return false;
    SetParent(hub,hubParent); SetStyle(hub,-16,hubStyle); SetWindowPlacement(hub,ref hubPlacement);
    // An unshown Electron HWND may report SW_SHOWNORMAL in placement. Apply
    // saved visibility separately so rollback does not unexpectedly show it.
    ShowWindow(hub,hubVisible ? 4 : 0); SetStyle(hub,-16,hubStyle);
    var actual=PlacementOf(hub);
    Trace("Hub rollback parent="+(GetParent(hub)==hubParent)+" style="+(GetStyle(hub,-16)==hubStyle)+" rect="+actual.Normal.Equals(hubPlacement.Normal)+" show="+actual.ShowCmd+"/"+hubPlacement.ShowCmd+" visible="+IsWindowVisible(hub)+"/"+hubVisible);
    return GetParent(hub)==hubParent && GetStyle(hub,-16)==hubStyle && actual.Normal.Equals(hubPlacement.Normal) && actual.ShowCmd==hubPlacement.ShowCmd && IsWindowVisible(hub)==hubVisible;
  }
  static void Inject(string point) { if(injection==point)throw new Exception("Injected failure: "+point); }
  static void Rollback() {
    rollbackAttempted=true;
    // Reverse mutation order. Never destroy the broker while a changed child
    // is still attached to it, even when attachment never reached 'attached'.
    if(chatChanged) { rollbackOrder.Add("fixture"); try { RestoreFixture(); }catch(Exception ex){Trace("fixture rollback error "+ex.Message);} }
    else if(fixture!=null && Alive(fixture,fixtureStart,chat)) { fixture.CloseMainWindow(); chatClosed=fixture.WaitForExit(5000); }
    if(hubChanged) { rollbackOrder.Add("hub"); try { hubRestored=RestoreHub(); }catch(Exception ex){Trace("Hub rollback error "+ex.Message);} }
    rollbackVerified=(!chatChanged||chatRestored)&&(!hubChanged||hubRestored)&&(fixture==null||chatClosed);
  }
  static void Complete() {
    Trace("Complete entered");
    if(finish)return;
    rootSurvived=IsWindow(root.Handle)&&GetParent(root.Handle)==IntPtr.Zero;
    controllerExited=controller.HasExited;
    RestoreFixture(); finish=true;
    status.Text="Controller exited. Fixture restored: "+chatRestored+". Broker root survived: "+rootSurvived;
    Save(); if(mode!="manual" || closingRequested)root.Close();
  }
  static void Save() {
    File.WriteAllText(resultPath,json.Serialize(new Dictionary<string,object> {
      {"attached",attached},{"sameRootAtAttach",attached},{"dpiAwarenessEqual",dpiEqual},{"resizeVerified",resized},
      {"controllerExited",controllerExited},{"brokerRootSurvived",rootSurvived},{"fixtureHwndSurvived",chatSurvived},
      {"fixtureRestoreVerified",chatRestored},{"fixtureNormallyClosed",chatClosed},{"error",error}
      ,{"injection",injection},{"hubChanged",hubChanged},{"fixtureChanged",chatChanged},{"rollbackAttempted",rollbackAttempted},
      {"hubRestoreVerified",hubRestored},{"hubAliveAtRollback",hubRestored&&Alive(controller,controllerStart,hub)},
      {"rollbackVerified",rollbackVerified},{"rollbackOrder",rollbackOrder},{"success",error==null&&finish&&chatRestored&&chatClosed}
    }));
  }
  static void Fail(string message) {
    if(finish)return;
    error=message; Rollback(); finish=true;
    status.Text=message+"; rollback verified: "+rollbackVerified;
    Save(); Emit("error","message",message,"rollbackVerified",rollbackVerified);
    // Keep root alive until controller consumes the failure acknowledgement
    // and exits. Closing it here can race Electron's close lifecycle and
    // return an incorrect startup exit code 0.
  }
  static string DpiName(IntPtr hwnd) {
    var context=GetWindowDpiAwarenessContext(hwnd);
    for(int i=1;i<=5;i++)if(AreDpiAwarenessContextsEqual(context,new IntPtr(-i)))return "context-"+i;
    return "unknown";
  }
  static void HandleLine(string line) {
    if(finish)return;
    var d=json.Deserialize<Dictionary<string,object>>(line);
    if(d==null || d.Count>6 || !d.ContainsKey("v") || Convert.ToInt32(d["v"])!=1 || !d.ContainsKey("nonce") || (string)d["nonce"]!=nonce || !d.ContainsKey("type"))throw new Exception("Invalid broker envelope");
    string type=(string)d["type"];
    Trace("command "+type);
    if(type=="attach" && !attached) {
      if(d.Count!=6 || Convert.ToInt32(d["pid"])!=controller.Id || (string)d["startTicks"]!=controllerStart.ToString() || controller.HasExited || controller.StartTime.ToUniversalTime().Ticks!=controllerStart)throw new Exception("Controller identity mismatch");
      long raw; if(!long.TryParse((string)d["hwnd"],out raw)||raw<=0)throw new Exception("Invalid HWND"); hub=new IntPtr(raw);
      if(!Alive(controller,controllerStart,hub)||GetParent(hub)!=IntPtr.Zero)throw new Exception("Hub HWND ownership/root mismatch");
      dpiEqual=AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(hub),GetWindowDpiAwarenessContext(root.Handle));
      if(!dpiEqual)throw new Exception("DPI awareness differs (Hub="+DpiName(hub)+", broker="+DpiName(root.Handle)+"); embedding refused");
      hubParent=GetParent(hub); hubStyle=GetStyle(hub,-16);hubPlacement=PlacementOf(hub);hubVisible=IsWindowVisible(hub);
      fixture=Process.Start(new ProcessStartInfo(Application.ExecutablePath,"--fixture "+nonce) { UseShellExecute=false }); fixtureStart=fixture.StartTime.ToUniversalTime().Ticks;
      for(int i=0;i<100;i++) { fixture.Refresh(); chat=fixture.MainWindowHandle; if(chat!=IntPtr.Zero)break; Thread.Sleep(50); }
      if(!Alive(fixture,fixtureStart,chat))throw new Exception("Owned fixture has no HWND");
      chatParent=GetParent(chat); chatStyle=GetStyle(chat,-16); chatPlacement=PlacementOf(chat);
      hubChanged=true; SetStyle(hub,-16,new IntPtr((hubStyle.ToInt64()|0x40000000L)&~0x80000000L)); SetParent(hub,pane.Handle); Inject("after-hub-parent");
      chatChanged=true; SetStyle(chat,-16,new IntPtr((chatStyle.ToInt64()|0x40000000L)&~0x80000000L)); SetParent(chat,pane.Handle); Inject("after-fixture-parent");
      if(GetParent(hub)!=pane.Handle || GetParent(chat)!=pane.Handle || GetAncestor(hub,2)!=root.Handle || GetAncestor(chat,2)!=root.Handle)throw new Exception("Shared broker root verification failed");
      attached=true; Layout(); Inject("after-resize"); status.Text="Isolated actual Hub + owned synthetic chat. No LINE account attached.";
      Trace("attached root="+root.Handle+" brokerPid="+Process.GetCurrentProcess().Id+" fixturePid="+fixture.Id); Emit("attached","rootHwnd",root.Handle.ToInt64().ToString()); Save();
    } else if(type=="shutdown" && d.Count==3) { closingRequested=true; status.Text="Waiting for Hub session flush and exit; broker stays alive."; }
    else if(type=="resize-check" && d.Count==3 && attached) {
      root.Size=new Size(root.Width+80,root.Height+40); Layout();
      Rect a,b,c; GetClientRect(pane.Handle,out a); GetWindowRect(hub,out b); GetWindowRect(chat,out c);
      Trace("resize pane="+a.Right+","+a.Bottom+" hub="+b.Left+","+b.Top+","+b.Right+","+b.Bottom+" chat="+c.Left+","+c.Top+","+c.Right+","+c.Bottom);
      resized=(b.Right-b.Left)+(c.Right-c.Left)==a.Right && b.Bottom-b.Top==a.Bottom && c.Bottom-c.Top==a.Bottom && b.Right==c.Left && b.Top==c.Top && GetAncestor(hub,2)==root.Handle && GetAncestor(chat,2)==root.Handle;
      Emit("resized","verified",resized); Save();
    } else throw new Exception("Unexpected broker command");
  }
  [STAThread] static int Main(string[] args) {
    Application.EnableVisualStyles();
    if(args.Length==2 && args[0]=="--fixture" && Regex.IsMatch(args[1],"^[a-f0-9]{48}$")) {
      Application.Run(new Form { Text="Owned synthetic native chat",Width=360,Height=450,Controls={ new Label { Text="Native chat fixture\n\nNo LINE or Chrome process.\n\nThis HWND is a sibling of the actual Hub.\nBroker owns the shared top-level root.",Dock=DockStyle.Fill,Padding=new Padding(20),Font=new Font("Segoe UI",12) } } }); return 0;
    }
    int pid;
    if(args.Length!=5 || !int.TryParse(args[0],out pid) || pid<=0 || !Regex.IsMatch(args[1],"^[a-f0-9]{48}$") || !Path.IsPathRooted(args[2]) || Path.GetFileName(args[2])!="broker-result.json" || !Path.GetFileName(Path.GetDirectoryName(args[2])).StartsWith("crosschat-broker-hub-") || (args[3]!="normal"&&args[3]!="crash"&&args[3]!="manual") || !Regex.IsMatch(args[4],"^(none|after-hub-parent|after-fixture-parent|after-resize|stdio-eof)$"))return 2;
    nonce=args[1];resultPath=args[2];mode=args[3];injection=args[4]; controller=Process.GetProcessById(pid); controllerStart=controller.StartTime.ToUniversalTime().Ticks;
    AppDomain.CurrentDomain.UnhandledException+=delegate(object s,UnhandledExceptionEventArgs e){Trace("unhandled "+e.ExceptionObject);};
    Trace("start brokerPid="+Process.GetCurrentProcess().Id+" controller="+pid);
    root=new Form { Text="CrossChat broker — isolated actual Hub study",Width=1660,Height=900,MinimumSize=new Size(1400,700),StartPosition=FormStartPosition.CenterScreen };
    status=new Label { Dock=DockStyle.Top,Height=34,Text="Waiting for isolated Hub handshake",Padding=new Padding(6) };
    var toolbar=new FlowLayoutPanel { Dock=DockStyle.Top,Height=36 };
    var focusHub=new Button { Text="Focus Hub",Width=120 }; focusHub.Click+=delegate { if(attached&&!finish)Emit("focus-hub"); };
    var focusChat=new Button { Text="Focus fixture",Width=120 }; focusChat.Click+=delegate { if(Alive(fixture,fixtureStart,chat))SetFocus(chat); };
    toolbar.Controls.Add(focusHub);toolbar.Controls.Add(focusChat);
    pane=new Panel { Dock=DockStyle.Fill }; root.Controls.Add(pane);root.Controls.Add(status);root.Controls.Add(toolbar);
    root.Resize+=delegate { try { Layout(); }catch(Exception ex){Fail(ex.Message);} };
    root.FormClosing+=delegate(object sender,FormClosingEventArgs e) {
      if(error!=null && !rollbackVerified && ((IsWindow(hub)&&GetAncestor(hub,2)==root.Handle)||(IsWindow(chat)&&GetAncestor(chat,2)==root.Handle))) { e.Cancel=true; return; }
      if(!finish && !controller.HasExited) { e.Cancel=true; if(!closingRequested){closingRequested=true;Emit("close-request");} }
    };
    root.FormClosed+=delegate {Trace("root closed finish="+finish);};
    var timer=new System.Windows.Forms.Timer { Interval=100 };
    timer.Tick+=delegate {
      if(finish && error!=null && rollbackVerified && controller.HasExited) { root.Close(); return; }
      if(!finish && controller.HasExited) { try { Complete(); } catch(Exception ex){Fail(ex.Message);} }
    };
    root.Shown+=delegate {
      Emit("ready","startTicks",controllerStart.ToString()); timer.Start();
      new Thread(delegate() { try {
        // Bound each line before allocation; read only the private inherited pipe.
        var line=new System.Text.StringBuilder(); int ch;
        while((ch=Console.In.Read())!=-1) { if(ch=='\n') { string copy=line.ToString().TrimEnd('\r'); line.Length=0; root.BeginInvoke((Action)delegate { try { HandleLine(copy); }catch(Exception ex){Fail(ex.Message);} }); } else { if(line.Length>=4096)throw new Exception("Broker input line exceeds limit");line.Append((char)ch); } }
        root.BeginInvoke((Action)delegate { if(!finish&&!closingRequested)Fail("Broker stdin EOF"); });
      } catch(Exception ex) { try { root.BeginInvoke((Action)delegate { Fail(ex.Message); }); }catch(InvalidOperationException){} } }) { IsBackground=true }.Start();
    };
    Application.Run(root);timer.Dispose();controller.Dispose();if(fixture!=null)fixture.Dispose();
    return error==null ? 0 : 1;
  }
}
