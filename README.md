一款网页版安卓投屏控制软件。  
基于  
scrcpy-server  <https://github.com/Genymobile/scrcpy>  
ws-scrcpy <https://github.com/NetrisTV/ws-scrcpy>  
由AI胡编乱造，修改而成

window环境双击start.cmd启动。  
浏览器自动打开<http://localhost:8080>

http下用MSE硬件解码，WASM软解  
https下用WebCodecs硬件解码，WASM软解

nas使用docker部署  
dockerhub地址：[linbei945/ws-scrcpy5](https://hub.docker.com/r/linbei945/ws-scrcpy5/tags)  
飞牛OS使用bridge网络，可使用飞牛官方APP远程访问，无需内网穿透。

