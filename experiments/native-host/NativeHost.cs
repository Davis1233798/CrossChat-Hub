using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Product experiment: window parenting only. No input injection, UI scraping,
// existing-process attachment, account access or messaging automation.
internal static class NativeHost {
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetStyle(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetStyle(IntPtr hwnd, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hwnd, ref Placement value);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr hwnd, ref Placement value);
  [StructLayout(LayoutKind.Sequential)] struct Placement { public int Length,Flags,ShowCmd; public Point Min,Max; public Rect Normal; }
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  const int Style = -16; const long Child=0x40000000L, Popup=0x80000000L, Caption=0x00C00000L, ThickFrame=0x00040000L;
  const uint FrameChanged=0x20, NoZOrder=4, NoActivate=0x10;
  [STAThread] static int Main(string[] args) {
    Application.EnableVisualStyles();
    if (args.Length>0 && args[0]=="--child") {
      var child=new Form { Text="CrossChat owned synthetic child", Width=640, Height=400 };
      child.Controls.Add(new TextBox { Multiline=true,Dock=DockStyle.Fill,Text="Owned fixture only. No chat data. Manual keyboard/IME testing surface." });
      Application.Run(child); return 0;
    }
    string chrome=null, output=null; int holdSeconds=2, attachPid=0; long attachHandle=0;
    for(int i=0;i<args.Length;i++) {
      if(args[i]=="--chrome" && i+1<args.Length) chrome=args[++i];
      else if(args[i]=="--output" && i+1<args.Length) output=args[++i];
      else if(args[i]=="--hold-seconds" && i+1<args.Length) { if(!int.TryParse(args[++i],out holdSeconds)||holdSeconds<2||holdSeconds>120) return 2; }
      else if(args[i]=="--attach-pid" && i+1<args.Length) { if(!int.TryParse(args[++i],out attachPid)||attachPid<=0) return 2; }
      else if(args[i]=="--attach-hwnd" && i+1<args.Length) { if(!long.TryParse(args[++i],out attachHandle)||attachHandle<=0) return 2; }
      else { Console.Error.WriteLine("Usage: NativeHost.exe [--chrome absolute-chrome.exe] --output absolute-result.json"); return 2; }
    }
    if(output==null || !Path.IsPathRooted(output) || (chrome!=null && (!Path.IsPathRooted(chrome)||!File.Exists(chrome))) || (attachPid!=0 && (chrome!=null||attachHandle==0))) return 2;
    var host=new Form { Text="CrossChat native host experiment", Width=960,Height=700 };
    var panel=new Panel { Dock=DockStyle.Fill }; host.Controls.Add(panel);
    Process owned=null; IntPtr hwnd=IntPtr.Zero,oldParent=IntPtr.Zero,oldStyle=IntPtr.Zero; Rect oldBounds=new Rect();
    bool attached=false, restored=false, embeddedVerified=false, resizeVerified=false; string error=null, profile=null;
    Placement oldPlacement=new Placement { Length=Marshal.SizeOf(typeof(Placement)) }; bool oldVisible=false;
    Action detach=()=> {
      if(!attached || !IsWindow(hwnd)) return;
      SetParent(hwnd,oldParent); SetStyle(hwnd,Style,oldStyle);
      SetWindowPos(hwnd,IntPtr.Zero,oldBounds.Left,oldBounds.Top,oldBounds.Right-oldBounds.Left,oldBounds.Bottom-oldBounds.Top,FrameChanged|NoZOrder|NoActivate);
      SetWindowPlacement(hwnd,ref oldPlacement);
      Rect restoredBounds; GetWindowRect(hwnd,out restoredBounds);
      restored=GetParent(hwnd)==oldParent && GetStyle(hwnd,Style)==oldStyle && oldVisible==IsWindowVisible(hwnd) && restoredBounds.Equals(oldBounds);
      attached=false;
    };
    Action resize=()=> { if(attached) SetWindowPos(hwnd,IntPtr.Zero,0,0,panel.ClientSize.Width,panel.ClientSize.Height,NoZOrder|NoActivate); };
    panel.Resize+=(s,e)=>resize(); host.FormClosing+=(s,e)=>detach();
    var timer=new Timer { Interval=200 }; int ticks=0;
    timer.Tick+=(s,e)=> {
      try {
        ticks++;
        if(!attached && !embeddedVerified) {
          owned.Refresh(); hwnd=attachPid==0?owned.MainWindowHandle:new IntPtr(attachHandle);
          if(hwnd==IntPtr.Zero) { if(ticks>100) throw new Exception("Owned process exposed no window within 20 seconds"); return; }
          uint actualPid; GetWindowThreadProcessId(hwnd,out actualPid);
          if(actualPid!=(uint)owned.Id) throw new Exception("Window ownership mismatch");
          if(!IsWindow(hwnd)||IsIconic(hwnd)||!IsWindowVisible(hwnd))throw new Exception("Target must be an existing visible non-minimized window");
          oldParent=GetParent(hwnd); oldStyle=GetStyle(hwnd,Style); GetWindowRect(hwnd,out oldBounds); GetWindowPlacement(hwnd,ref oldPlacement); oldVisible=IsWindowVisible(hwnd);
          SetStyle(hwnd,Style,new IntPtr((oldStyle.ToInt64()|Child)&~(Popup|Caption|ThickFrame)));
          SetParent(hwnd,panel.Handle); attached=true; resize();
          embeddedVerified=GetParent(hwnd)==panel.Handle && (GetStyle(hwnd,Style).ToInt64()&Child)!=0;
          if(!embeddedVerified) throw new Exception("Parent/style read-back failed");
          host.Width=1040; host.Height=740; resize();
          Rect current; GetWindowRect(hwnd,out current);
          resizeVerified=current.Right-current.Left==panel.ClientSize.Width && current.Bottom-current.Top==panel.ClientSize.Height;
          ticks=0;
        } else if(ticks>=holdSeconds*5) { detach(); timer.Stop(); host.Close(); }
      } catch(Exception ex) { error=ex.Message; timer.Stop(); detach(); host.Close(); }
    };
    host.Shown+=(s,e)=> {
      try {
        var start=new ProcessStartInfo { UseShellExecute=false };
        if(attachPid!=0) {
          owned=Process.GetProcessById(attachPid);
          if(!owned.MainModule.FileName.EndsWith("\\LINE\\bin\\current\\LINE.exe",StringComparison.OrdinalIgnoreCase)) throw new Exception("Attach target is not the approved native LINE executable");
          timer.Start(); return;
        }
        if(chrome==null) { start.FileName=Application.ExecutablePath; start.Arguments="--child"; }
        else {
          profile=Path.Combine(Path.GetTempPath(),"crosschat-native-chrome-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(profile);
          start.FileName=chrome; start.Arguments="--user-data-dir=\""+profile+"\" --no-first-run --no-default-browser-check --new-window about:blank";
        }
        owned=Process.Start(start); timer.Start();
      } catch(Exception ex) { error=ex.Message; host.Close(); }
    };
    Application.Run(host);
    if(chrome==null && attachPid==0 && owned!=null && !owned.HasExited) { owned.CloseMainWindow(); owned.WaitForExit(5000); }
    // Chrome remains restored as its own isolated window; never close user Chrome.
    Func<string,string> quote=v=>v==null?"null":"\""+v.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r"," ").Replace("\n"," ")+"\"";
    File.WriteAllText(output,"{\"mode\":"+quote(attachPid!=0?"line-attach":chrome==null?"synthetic":"chrome")+",\"embeddedParentAndStyleVerified\":"+embeddedVerified.ToString().ToLowerInvariant()+",\"resizeVerified\":"+resizeVerified.ToString().ToLowerInvariant()+",\"restoredParentStyleBoundsVisibilityVerified\":"+restored.ToString().ToLowerInvariant()+",\"profile\":"+quote(profile)+",\"error\":"+quote(error)+"}");
    return embeddedVerified && resizeVerified && restored && error==null ? 0 : 1;
  }
}
