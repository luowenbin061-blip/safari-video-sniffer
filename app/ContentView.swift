import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    SectionCard(
                        title: "第一次要手动开启扩展",
                        lines: [
                            "打开 设置 → Safari 浏览器 → 扩展",
                            "找到「视频嗅探」，打开开关",
                            "回到 Safari，点地址栏左侧「AA」→ 管理扩展，确认这里是勾上的"
                        ]
                    )

                    SectionCard(
                        title: "怎么用",
                        lines: [
                            "打开有视频的网页，让视频先播放几秒（这样才嗅得到地址）",
                            "长按视频画面 —— 弹出嗅探面板",
                            "点某一行 = 复制地址；长按某一行 = 系统菜单，里面可以「下载链接文件」",
                            "右下角的蓝色圆点可以随时把面板叫出来"
                        ]
                    )

                    SectionCard(
                        title: "能下什么、不能下什么",
                        lines: [
                            "MP4 直链：长按链接选「下载链接文件」就能存下来",
                            "M3U8：只能复制地址，要另外的工具去拼分片",
                            "DRM 加密的付费影片：拿不到，这个绕不过去",
                            "blob 开头的：说明视频是脚本喂给播放器的，需要在点开面板之后重新加载页面才能抓到真实地址"
                        ]
                    )
                }
                .padding(16)
            }
            .navigationTitle("视频嗅探")
        }
        .navigationViewStyle(.stack)
    }
}

private struct SectionCard: View {
    let title: String
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)

            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(index + 1).")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .frame(width: 18, alignment: .leading)
                    Text(line)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemBackground))
        .cornerRadius(12)
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
