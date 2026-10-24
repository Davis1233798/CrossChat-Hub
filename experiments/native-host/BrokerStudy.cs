using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// Synthetic-only: the broker owns the TOP-LEVEL shell. Controller and chat
// fixtures are siblings, never ancestors of each other. No external PID mode.
internal static class BrokerStudy {
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
  [StructLayout(LayoutKind.Sequential)] struct Placement { public int Length, Flags, ShowCmd; public Point Min, Max; public Rect Normal; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }

  sealed class OwnedFixture : IDisposable {
    public Process Process; public long StartTicks; public IntPtr Window;
    public IntPtr Parent, Style; public Placement Placement;
    public bool Embedded;
    public OwnedFixture(string role) {
      Process = Process.Start(new ProcessStartInfo(Application.ExecutablePath, "--fixture " + role) { UseShellExecute=false });
      StartTicks = Process.StartTime.ToUniversalTime().Ticks;
      for (int i=0; i<100; i++) {
        Process.Refresh(); if (Process.HasExited) throw new Exception("Owned fixture exited before window creation");
        Window = Process.MainWindowHandle; if (Window != IntPtr.Zero) break;
        Application.DoEvents(); Thread.Sleep(50);
      }
      if (!AliveWindow()) throw new Exception("Owned fixture HWND identity mismatch");
      Parent = GetParent(Window); Style = GetStyle(Window, -16);
      Placement = new Placement { Length=Marshal.SizeOf(typeof(Placement)) };
      if (!GetWindowPlacement(Window, ref Placement)) throw new Exception("Cannot save owned fixture placement");
    }
    public bool SameProcess() { Process.Refresh(); return !Process.HasExited && Process.StartTime.ToUniversalTime().Ticks==StartTicks; }
    public bool AliveWindow() { uint pid; return SameProcess() && IsWindow(Window) && GetWindowThreadProcessId(Window, out pid)!=0 && pid==(uint)Process.Id; }
    public void Embed(IntPtr parent, Rectangle bounds) {
      if (!AliveWindow()) throw new Exception("Owned fixture changed before embedding");
      // Mark before mutation so cleanup restores even after partial failure.
      Embedded=true;
      SetStyle(Window, -16, new IntPtr((Style.ToInt64() | 0x40000000L) & ~0x80000000L));
      SetParent(Window, parent);
      if (GetParent(Window)!=parent || !MoveWindow(Window, bounds.X, bounds.Y, bounds.Width, bounds.Height, true)) throw new Exception("Owned fixture embedding failed");
    }
    public bool Restore() {
      if (!AliveWindow()) return false;
      SetParent(Window, Parent); SetStyle(Window, -16, Style); SetWindowPlacement(Window, ref Placement);
      var observed = new Placement { Length=Marshal.SizeOf(typeof(Placement)) };
      bool read=GetWindowPlacement(Window, ref observed);
      bool restored=read && GetParent(Window)==Parent && GetStyle(Window,-16)==Style && observed.Normal.Equals(Placement.Normal) && observed.ShowCmd==Placement.ShowCmd && IsWindowVisible(Window);
      if(restored) Embedded=false;
      return restored;
    }
    public void HardExit() {
      if (!SameProcess()) throw new Exception("Owned fixture identity changed before termination");
      Process.Kill();
      if (!Process.WaitForExit(5000)) throw new Exception("Owned fixture did not terminate");
    }
    public void Dispose() { Process.Dispose(); }
  }

  [STAThread] static int Main(string[] args) {
    Application.EnableVisualStyles();
    if (args.Length==2 && args[0]=="--fixture" && (args[1]=="controller" || args[1]=="chat")) {
      using(var fixture=new Form { Text="CrossChat broker-study owned " + args[1], Width=600, Height=350 }) {
        fixture.Controls.Add(new Label { Text="Synthetic " + args[1] + ". No accounts or chat applications.", Dock=DockStyle.Fill });
        Application.Run(fixture);
      }
      return 0;
    }
    if (args.Length!=2 || args[0]!="--output" || !Path.IsPathRooted(args[1])) return 2;
    bool sameRoot=false, controllerExited=false, brokerSurvived=false, childSurvived=false, restored=false, normallyClosed=false, forcedCleanup=false;
    string error=null; OwnedFixture controller=null, chat=null;
    using(var broker=new Form { Text="CrossChat synthetic broker TOP-LEVEL shell", Width=1000, Height=600 }) {
      broker.Shown += delegate {
        broker.BeginInvoke((Action)delegate {
          try {
            controller=new OwnedFixture("controller"); chat=new OwnedFixture("chat");
            controller.Embed(broker.Handle, new Rectangle(0,0,240,broker.ClientSize.Height));
            chat.Embed(broker.Handle, new Rectangle(240,0,broker.ClientSize.Width-240,broker.ClientSize.Height));
            uint owner; GetWindowThreadProcessId(broker.Handle,out owner);
            sameRoot=GetParent(broker.Handle)==IntPtr.Zero && owner==(uint)Process.GetCurrentProcess().Id && GetAncestor(controller.Window,2)==broker.Handle && GetAncestor(chat.Window,2)==broker.Handle && GetParent(chat.Window)==broker.Handle && GetParent(controller.Window)==broker.Handle;
            if(!sameRoot) throw new Exception("Broker is not the shared top-level root");
            controller.HardExit(); controllerExited=controller.Process.HasExited;
            brokerSurvived=IsWindow(broker.Handle) && GetParent(broker.Handle)==IntPtr.Zero;
            childSurvived=chat.AliveWindow() && GetParent(chat.Window)==broker.Handle;
            restored=chat.Restore();
            if(!restored) throw new Exception("Broker could not restore owned chat fixture");
          } catch(Exception ex) { error=ex.Message; }
          finally {
            // Restore before destroying broker/root. Termination is limited to
            // handles created here and validated with PID plus start time.
            if(chat!=null) {
              if(chat.Embedded && chat.AliveWindow()) chat.Restore();
              if(chat.AliveWindow()) { chat.Process.CloseMainWindow(); normallyClosed=chat.Process.WaitForExit(5000); }
              if(chat.SameProcess()) { chat.HardExit(); forcedCleanup=true; }
              chat.Dispose();
            }
            if(controller!=null) { if(controller.SameProcess()) { if(controller.Embedded) controller.Restore(); controller.HardExit(); forcedCleanup=true; } controller.Dispose(); }
            broker.Close();
          }
        });
      };
      Application.Run(broker);
    }
    Func<bool,string> b=v=>v?"true":"false";
    Func<string,string> q=v=>v==null?"null":"\""+v.Replace("\\","\\\\").Replace("\"","\\\"")+"\"";
    File.WriteAllText(args[1], "{\"sameTopLevelBrokerRoot\":"+b(sameRoot)+",\"ownedControllerHardExit\":"+b(controllerExited)+",\"brokerRootSurvived\":"+b(brokerSurvived)+",\"chatHwndSurvived\":"+b(childSurvived)+",\"chatRestoreVerified\":"+b(restored)+",\"chatNormallyClosed\":"+b(normallyClosed)+",\"forcedOwnedFixtureCleanup\":"+b(forcedCleanup)+",\"error\":"+q(error)+"}");
    return sameRoot && controllerExited && brokerSurvived && childSurvived && restored && normallyClosed && !forcedCleanup && error==null ? 0 : 1;
  }
}
