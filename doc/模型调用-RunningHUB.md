// 工作流API 密钥
{
    "apiUrl": "https://www.runninghub.cn/openapi/v2/query",
    "apiKey": "***********************************",
    "taskId": "aic-connection-test"
}
{
    "taskId": "",
    "status": "",
    "errorCode": "1007",
    "errorMessage": "failed to parse request body",
    "results": null,
    "clientId": "",
    "promptTips": "",
    "failedReason": {},
    "usage": null,
    "parentTaskId": null,
    "taskUsageList": null
}

// 模型API 密钥
{
    "apiUrl": "https://www.runninghub.cn/uc/openapi/accountStatus",
    "apiKey": "************************************",
    "apikey": "***********************************"
}
{
    "code": 0,
    "msg": "success",
    "errorMessages": null,
    "data": {
        "remainCoins": "1100",
        "currentTaskCounts": "0",
        "remainMoney": null,
        "currency": null,
        "apiType": "NORMAL"
    }
}

——————————————————————————————————————————————————————————————————————————————————————————————
// 一键360度全景图
Request URL
http://127.0.0.1:8777/api/v2/proxy/upload?apiUrl=https%3A%2F%2Fwww.runninghub.cn%2Fopenapi%2Fv2%2Fmedia%2Fupload%2Fbinary
Request Method
POST
Status Code
200 OK
Remote Address
127.0.0.1:8777
Referrer Policy
strict-origin-when-cross-origin
access-control-allow-origin
http://127.0.0.1:8777
cache-control
no-store, no-cache, must-revalidate, max-age=0
content-length
569
content-type
application/json; charset=utf-8
date
Sat, 30 May 2026 14:39:21 GMT

server
SimpleHTTP/0.6 Python/3.10.15
vary
Origin
x-aicanvas-server
AI CanvasPro
accept
*/*
accept-encoding
gzip, deflate, br, zstd
accept-language
en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7
authorization
Bearer 5da15ba63fe04b949b437768f5d5c7da
connection
keep-alive
content-length
1470943
content-type
multipart/form-data; boundary=----WebKitFormBoundarymCSXYDkqv1UAZ4wX
cookie
sidebar:state=true
host
127.0.0.1:8777
origin
http://127.0.0.1:8777
referer
http://127.0.0.1:8777/
sec-ch-ua
"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
sec-ch-ua-mobile
?0
sec-ch-ua-platform
"Windows"
sec-fetch-dest
empty
sec-fetch-mode
cors
sec-fetch-site
same-origin
user-agent
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
x-aic-device-id
aic-mpihy8g9-16gvbpz

{
    "code": 0,
    "msg": "success",
    "errorMessages": null,
    "data": {
        "type": "image",
        "download_url": "https://rh-images-switch-1252422369.cos.ap-guangzhou.myqcloud.com/input/openapi/c2067cf99dc6247108dd0970c697df6e7f43cde9d347aea89bdcfaec40ef33fd.png?q-sign-algorithm=sha1&q-ak=AKIDv56FISEJUsKsMeELk0gmbNCGKTYSaZ3N&q-sign-time=1780151960%3B1780238360&q-key-time=1780151960%3B1780238360&q-header-list=host&q-url-param-list=&q-signature=97799047e35fec62b21a7bf6143ea8f12cf06b1c",
        "fileName": "openapi/c2067cf99dc6247108dd0970c697df6e7f43cde9d347aea89bdcfaec40ef33fd.png",
        "size": "1470760"
    }
}


http://127.0.0.1:8777/api/v2/proxy/image
{
    "apiKey": "5da15ba63fe04b949b437768f5d5c7da",
    "nodeInfoList": [
        {
            "nodeId": "147",
            "fieldName": "image",
            "fieldValue": "https://rh-images-switch-1252422369.cos.ap-guangzhou.myqcloud.com/input/openapi/c2067cf99dc6247108dd0970c697df6e7f43cde9d347aea89bdcfaec40ef33fd.png?q-sign-algorithm=sha1&q-ak=AKIDv56FISEJUsKsMeELk0gmbNCGKTYSaZ3N&q-sign-time=1780151960%3B1780238360&q-key-time=1780151960%3B1780238360&q-header-list=host&q-url-param-list=&q-signature=97799047e35fec62b21a7bf6143ea8f12cf06b1c",
            "description": "image"
        }
    ],
    "instanceType": "default",
    "usePersonalQueue": "false",
    "apiUrl": "https://www.runninghub.cn/openapi/v2/run/ai-app/2044874075721441281"
}
{
    "task_id": "2060732799526334466",
    "status": "submitted",
    "source": "body-probe"
}