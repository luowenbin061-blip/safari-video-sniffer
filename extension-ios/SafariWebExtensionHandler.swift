import Foundation
import SafariServices

/// Safari Web Extension 的 native 侧入口。
///
/// 嗅探和界面全在 JavaScript 里完成，这个类现在不做任何事 ——
/// 它存在的意义有两个：
///   1. 让扩展 target 有一个可编译的源文件（纯资源 target 编不出二进制）；
///   2. 预留位置。以后如果要把「地址交给 native 后台直接下载」做进来，
///      就从这里接 `SFExtensionMessageKey`。
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let item = NSExtensionItem()
        item.userInfo = [
            SFExtensionMessageKey: ["ok": true]
        ]
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }
}
