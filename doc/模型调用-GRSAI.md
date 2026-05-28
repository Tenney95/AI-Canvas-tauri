_____________________________________GRSAI_____________________________________
// 绘画模型请求
{
    "apiUrl": "https://grsai.dakka.com.cn/v1/api/generate",
    "apiKey": "***************************************",
    "model": "nano-banana",
    "prompt": "新古典主义油画厚涂，中国古典美人林黛玉，20岁左右身形单薄纤细弱柳扶风，眉尖若蹙的含烟罥烟眉，眼尾带着淡淡哭过的绯红，眼波清亮裹着一层淡愁，无浓妆，素白面庞泛着极淡的病态薄红，鬓边仅簪一朵半开的白梨花，没有多余贵重首饰，身着月白绣暗纹青竹的交领褙子，下着烟绿素罗长裙，纤细葱白的指尖沾了一点桃花粉，正站在暮春的潇湘馆青竹下，半侧身子轻倚着半旧的葬花锄，锄边落着半袋散出来的粉桃花瓣，风卷起软纱裙角和鬓边碎发，漫天飘着粉白的落英，脚边是长满苔藓的青石板，远处潇湘馆的雕花木窗漏出一点暖黄烛火，竹影婆娑半落在人脸上，清晰可见的厚涂笔刷堆叠纹理，油彩肌理厚重有触感，带刮刀刮过的颜料凹凸质感，色彩通透低饱和，是莫兰迪调的柔雾国风质感，光影为春日傍晚的漫反射柔金光线，明暗层次丰富，氛围感拉满，大师级创作，8K超高细节",
    "images": [],
    "replyType": "json",
    "imageSize": "1K",
    "aspectRatio": "2:3"
}
{
    "id": "12-b66dd9f4-7daa-408e-9944-aedeb51c6c12",
    "status": "succeeded",
    "results": [
        {
            "url": "https://file4.aitohumanize.com/file/a504c32f86644ef69c2157dfcc8c43e0.png"
        }
    ],
    "progress": 100
}

// 测试链接
{
    "apiUrl": "https://grsai.dakka.com.cn/v1",
    "apiKey": "****************************",
    "model": "gemini-3.1-pro",
    "stream": false,
    "messages": [
        {
            "role": "user",
            "content": "你好"
        }
    ]
}
{
    "id": "16-e399ed6f-3aea-4e4f-ab3b-3ae31e6abea3",
    "object": "",
    "created": 1779951155,
    "model": "gemini-3.1-pro",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "你好！請問有什麼我可以幫忙的嗎？"
            },
            "finish_reason": "stop",
            "content_filter_results": {
                "hate": {
                    "filtered": false
                },
                "self_harm": {
                    "filtered": false
                },
                "sexual": {
                    "filtered": false
                },
                "violence": {
                    "filtered": false
                },
                "jailbreak": {
                    "filtered": false,
                    "detected": false
                },
                "profanity": {
                    "filtered": false,
                    "detected": false
                }
            }
        }
    ],
    "usage": {
        "prompt_tokens": 83,
        "completion_tokens": 276,
        "total_tokens": 359,
        "prompt_tokens_details": null,
        "completion_tokens_details": null
    },
    "system_fingerprint": ""
}
__________________________________________________________________________