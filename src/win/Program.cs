// 3DViewer for Windows: the 3DViewer web app in a WebView2 window (the browser built into Windows 10/11), as BoardV.
// Everything ships inside this one exe: the web app (www.zip), the WebView2 libraries and the bridge script.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TDV
{
    static class Build
    {
        public static readonly Dictionary<string, string> V = Read();
        static Dictionary<string, string> Read()
        {
            var d = new Dictionary<string, string>();
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("build.txt"))
            using (var r = new StreamReader(s, Encoding.UTF8))
                foreach (var line in r.ReadToEnd().Split('\n'))
                {
                    int i = line.IndexOf('='); if (i > 0) d[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
                }
            return d;
        }
        public static string Get(string k, string def) { string v; return V.TryGetValue(k, out v) && v != "" ? v : def; }
        public static string Version { get { return Get("version", "0.0.0"); } }
        public static string PortableName { get { return Get("portable", "3DViewer-portable.exe"); } }
    }

    static class Program
    {
        public const string Name = "3DViewer";
        public const string Host = "app.3dviewer";
        public static string Home;      // %LOCALAPPDATA%\3DViewer (data, unpacked app)
        public static string AppDir;    // unpacked www + WebView2Loader.dll for this version
        public static bool Portable;
        static Mutex single;

        [STAThread]
        static void Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) => // the WebView2 .NET libraries live inside this exe
            {
                string name = new AssemblyName(e.Name).Name + ".dll";
                using (var st = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (st == null) return null;
                    var b = new byte[st.Length]; st.Read(b, 0, b.Length); return Assembly.Load(b);
                }
            };
            Run(args);
        }

        static void Run(string[] args)
        {
            string pipeName = "3DViewer-open-" + Environment.UserName;
            bool first;
            single = new Mutex(true, "Local\\" + pipeName, out first);
            if (!first) { PassToRunning(pipeName, args); return; } // a second launch (double-click on a model) opens it in the running window

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            System.Net.ServicePointManager.SecurityProtocol = System.Net.SecurityProtocolType.Tls12;

            string exe = Assembly.GetExecutingAssembly().Location;
            Portable = !File.Exists(Path.Combine(Path.GetDirectoryName(exe), "installed.flag"));
            Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Name);
            try { AppDir = Unpack(); }
            catch (Exception e) { MessageBox.Show("Не удалось подготовить 3DViewer: " + e.Message, Name, MessageBoxButtons.OK, MessageBoxIcon.Error); return; }

            string wv = null;
            try { CoreWebView2Environment.SetLoaderDllFolderPath(AppDir); wv = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
            if (string.IsNullOrEmpty(wv))
            {
                if (MessageBox.Show("Для 3DViewer нужен компонент Microsoft Edge WebView2 (обычно он уже есть в Windows 10 и 11).\n\nОткрыть страницу загрузки?",
                    Name, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                    try { Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703"); } catch { }
                return;
            }
            var form = new MainForm(args.Where(ModelFile).ToList());
            new Thread(() => ListenForOthers(pipeName, form)) { IsBackground = true }.Start();
            Application.Run(form);
            GC.KeepAlive(single);
        }

        public static bool ModelFile(string a)
        {
            try
            {
                return File.Exists(a) && System.Text.RegularExpressions.Regex.IsMatch(a,
                    @"\.(step|stp|p21|iges|igs|brep|brp|stl|obj|mtl|gltf|glb|bin|fbx|dae|3ds|ply|3mf|amf|wrl|vrml|vtk|vtp|pcd|xyz|usdz|lwo|kmz|off|3dv|sldprt|sldasm)$",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            }
            catch { return false; }
        }

        // the web app and the native WebView2 loader are unpacked once per version
        static string Unpack()
        {
            string dir = Path.Combine(Home, "app-" + Build.Version);
            string mark = Path.Combine(dir, ".ok");
            if (File.Exists(mark)) return dir;
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            var asm = Assembly.GetExecutingAssembly();
            using (var z = asm.GetManifestResourceStream("www.zip"))
            using (var zip = new ZipArchive(z, ZipArchiveMode.Read))
                foreach (var en in zip.Entries)
                {
                    if (en.FullName.EndsWith("/")) continue;
                    string to = Path.GetFullPath(Path.Combine(dir, "www", en.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!to.StartsWith(Path.Combine(dir, "www"), StringComparison.OrdinalIgnoreCase)) continue;
                    Directory.CreateDirectory(Path.GetDirectoryName(to));
                    en.ExtractToFile(to, true);
                }
            using (var st = asm.GetManifestResourceStream("WebView2Loader.dll"))
            using (var f = File.Create(Path.Combine(dir, "WebView2Loader.dll"))) st.CopyTo(f);
            File.WriteAllText(mark, Build.Version);
            foreach (var old in Directory.GetDirectories(Home, "app-*")) if (!string.Equals(old, dir, StringComparison.OrdinalIgnoreCase)) try { Directory.Delete(old, true); } catch { }
            return dir;
        }

        static void PassToRunning(string pipe, string[] args)
        {
            try
            {
                using (var c = new NamedPipeClientStream(".", pipe, PipeDirection.Out))
                {
                    c.Connect(3000);
                    var b = Encoding.UTF8.GetBytes(string.Join("\n", args.Where(ModelFile).Select(Path.GetFullPath)) + "\n\u0004");
                    c.Write(b, 0, b.Length); c.Flush();
                }
            }
            catch { }
        }

        static void ListenForOthers(string pipe, MainForm form)
        {
            while (true)
            {
                try
                {
                    using (var s = new NamedPipeServerStream(pipe, PipeDirection.In, 1))
                    {
                        s.WaitForConnection();
                        var r = new StreamReader(s, Encoding.UTF8);
                        var files = r.ReadToEnd().Replace("\u0004", "").Split('\n').Where(x => x.Trim() != "").ToList();
                        form.BeginInvoke((Action)(() => form.OpenFromOutside(files)));
                    }
                }
                catch { Thread.Sleep(500); }
            }
        }
    }

    class MainForm : Form
    {
        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        protected override void OnHandleCreated(EventArgs e) // a dark title bar to match the app
        {
            base.OnHandleCreated(e);
            try
            {
                int on = 1; if (DwmSetWindowAttribute(Handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(Handle, 19, ref on, 4);
                int cap = 0x00161713, text = 0x00e7ebe4; // Windows 11: caption and text colours (0x00BBGGRR)
                DwmSetWindowAttribute(Handle, 35, ref cap, 4); DwmSetWindowAttribute(Handle, 36, ref text, 4);
            }
            catch { }
        }
        readonly WebView2 web = new WebView2();
        readonly List<string> pending;
        bool pageReady;
        public readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        Updater updater;
        string lastFolder;

        public MainForm(List<string> files)
        {
            pending = files;
            Text = Program.Name;
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
            BackColor = ColorTranslator.FromHtml("#131716");
            MinimumSize = new Size(900, 600);
            Size = new Size(1440, 900);
            StartPosition = FormStartPosition.CenterScreen;
            WindowState = FormWindowState.Maximized;
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            updater = new Updater(this);
            Load += async (s, e) => await Init();
        }

        async Task Init()
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.Home, "WebView2"), new CoreWebView2EnvironmentOptions("--disable-features=msSmartScreenProtection"));
                await web.EnsureCoreWebView2Async(env);
                var cw = web.CoreWebView2;
                cw.Settings.AreDevToolsEnabled = false;
                cw.Settings.AreDefaultContextMenusEnabled = true;     // the page shows its own menus and keeps the system one only in text fields
                cw.Settings.IsStatusBarEnabled = false;
                cw.Settings.IsZoomControlEnabled = false;
                cw.Settings.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+S, Ctrl+O, F5... belong to 3DViewer
                cw.Settings.IsPasswordAutosaveEnabled = false;
                cw.Settings.IsGeneralAutofillEnabled = false;
                cw.SetVirtualHostNameToFolderMapping(Program.Host, Path.Combine(Program.AppDir, "www"), CoreWebView2HostResourceAccessKind.Allow);
                // settings of the earlier Electron build move over once (only into an empty profile)
                var old = Migrate.OldSettings();
                if (old.Count > 0)
                    await cw.AddScriptToExecuteOnDocumentCreatedAsync("(function (o) { try { if (localStorage.getItem('tdv-migrated')) return; for (var k in o) if (/^tdv\\./.test(k) && localStorage.getItem(k) === null) localStorage.setItem(k, o[k]); localStorage.setItem('tdv-migrated', '1'); } catch (e) {} })(" + Json.Serialize(old) + ");");
                string head = "window.TDV_WIN = " + Json.Serialize(new Dictionary<string, object> { { "portable", Build.PortableName }, { "version", Build.Version } }) + ";\n";
                using (var st = Assembly.GetExecutingAssembly().GetManifestResourceStream("shim.js"))
                using (var r = new StreamReader(st, Encoding.UTF8)) await cw.AddScriptToExecuteOnDocumentCreatedAsync(head + r.ReadToEnd());
                cw.WebMessageReceived += OnMessage;
                cw.NewWindowRequested += (s, e) => { e.Handled = true; External(e.Uri); };
                cw.NavigationStarting += (s, e) => { if (!e.Uri.StartsWith("https://" + Program.Host + "/", StringComparison.OrdinalIgnoreCase)) { e.Cancel = true; External(e.Uri); } };
                cw.DocumentTitleChanged += (s, e) => { Text = string.IsNullOrEmpty(cw.DocumentTitle) || cw.DocumentTitle.StartsWith(Program.Host) ? Program.Name : cw.DocumentTitle; };
                cw.DownloadStarting += OnDownload;
                cw.Navigate("https://" + Program.Host + "/index.html");
            }
            catch (Exception ex)
            {
                MessageBox.Show("WebView2 не запустился: " + ex.Message, Program.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        static void External(string url)
        {
            if (string.IsNullOrEmpty(url) || !(url.StartsWith("http://") || url.StartsWith("https://") || url.StartsWith("mailto:"))) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        public void Post(Dictionary<string, object> m)
        {
            if (InvokeRequired) { BeginInvoke((Action)(() => Post(m))); return; }
            try { if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(m)); } catch { }
        }
        public void Event(string kind, string type, object data) { Post(new Dictionary<string, object> { { "t", kind }, { "m", new Dictionary<string, object> { { "type", type }, { "data", data } } } }); }
        void Reply(object req, object data, string error)
        {
            var m = new Dictionary<string, object> { { "t", "res" }, { "req", req }, { "data", data } };
            if (error != null) m["error"] = error;
            Post(m);
        }

        async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> m;
            try { m = Json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); } catch { return; }
            string t = m.ContainsKey("t") ? m["t"] as string : null;
            object req = m.ContainsKey("req") ? m["req"] : null;
            switch (t)
            {
                case "ready":
                    pageReady = true; OpenFromOutside(pending); pending.Clear(); break;
                case "save-file":
                    try { Reply(req, SaveFile(m.ContainsKey("name") ? (string)m["name"] : "model", Convert.FromBase64String((string)m["b64"])), null); }
                    catch (Exception ex) { Reply(req, null, ex.Message); }
                    break;
                case "upd-check": Reply(req, await updater.Check(), null); break;
                case "upd-download": Reply(req, await updater.Download(), null); break;
                case "upd-install": if (updater.Install()) Close(); break;
            }
        }

        // the Windows "Save as" dialog; returns the path or null when cancelled
        string SaveFile(string name, byte[] data)
        {
            string ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
            using (var d = new SaveFileDialog())
            {
                d.FileName = name;
                d.Filter = (ext != "" ? ext.ToUpperInvariant() + " (*." + ext + ")|*." + ext + "|" : "") + "Все файлы (*.*)|*.*";
                d.OverwritePrompt = true;
                if (lastFolder != null && Directory.Exists(lastFolder)) d.InitialDirectory = lastFolder;
                if (d.ShowDialog(this) != DialogResult.OK) return null;
                File.WriteAllBytes(d.FileName, data);
                lastFolder = Path.GetDirectoryName(d.FileName);
                return d.FileName;
            }
        }

        // a download the page starts itself (a link, a blob): ask where to save instead of the Edge download bar
        void OnDownload(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            var deferral = e.GetDeferral();
            BeginInvoke((Action)(() =>
            {
                try
                {
                    using (var d = new SaveFileDialog())
                    {
                        d.FileName = Path.GetFileName(e.ResultFilePath);
                        d.Filter = "Все файлы (*.*)|*.*";
                        if (lastFolder != null && Directory.Exists(lastFolder)) d.InitialDirectory = lastFolder;
                        if (d.ShowDialog(this) == DialogResult.OK) { e.ResultFilePath = d.FileName; e.Handled = true; lastFolder = Path.GetDirectoryName(d.FileName); }
                        else e.Cancel = true;
                    }
                }
                catch { }
                finally { deferral.Complete(); }
            }));
        }

        public void OpenFromOutside(List<string> files)
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Maximized;
            Activate();
            if (files == null || files.Count == 0) return;
            if (!pageReady) { pending.AddRange(files); return; }
            var list = new List<object>();
            foreach (var f in files)
                try { list.Add(new Dictionary<string, object> { { "name", Path.GetFileName(f) }, { "b64", Convert.ToBase64String(File.ReadAllBytes(f)) } }); } catch { }
            if (list.Count > 0) Post(new Dictionary<string, object> { { "t", "open-files" }, { "files", list } });
        }
    }
}
