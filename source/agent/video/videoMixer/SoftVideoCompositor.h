/*
 * Copyright 2017 Intel Corporation All Rights Reserved.
 *
 * The source code contained or described herein and all documents related to the
 * source code ("Material") are owned by Intel Corporation or its suppliers or
 * licensors. Title to the Material remains with Intel Corporation or its suppliers
 * and licensors. The Material contains trade secrets and proprietary and
 * confidential information of Intel or its suppliers and licensors. The Material
 * is protected by worldwide copyright and trade secret laws and treaty provisions.
 * No part of the Material may be used, copied, reproduced, modified, published,
 * uploaded, posted, transmitted, distributed, or disclosed in any way without
 * Intel's prior express written permission.
 *
 * No license under any patent, copyright, trade secret or other intellectual
 * property right is granted to or conferred upon you by disclosure or delivery of
 * the Materials, either expressly, by implication, inducement, estoppel or
 * otherwise. Any license under such intellectual property rights must be express
 * and approved by Intel in writing.
 */

#ifndef SoftVideoCompositor_h
#define SoftVideoCompositor_h

#include <vector>

#include <boost/scoped_ptr.hpp>
#include <boost/shared_ptr.hpp>
#include <boost/thread/shared_mutex.hpp>

#include <webrtc/system_wrappers/include/clock.h>
#include <webrtc/api/video/video_frame.h>
#include <webrtc/api/video/i420_buffer.h>

#include "logger.h"
#include "JobTimer.h"
#include "MediaFramePipeline.h"
#include "FrameConverter.h"
#include "VideoFrameMixer.h"
#include "VideoLayout.h"
#include "I420BufferManager.h"

namespace mcu {
class SoftVideoCompositor;

class AvatarManager {
    DECLARE_LOGGER();

public:
    AvatarManager(uint8_t size);
    ~AvatarManager();

    bool setAvatar(uint8_t index, const std::string &url);
    bool unsetAvatar(uint8_t index);

    boost::shared_ptr<webrtc::VideoFrame> getAvatarFrame(uint8_t index);

protected:
    bool getImageSize(const std::string &url, uint32_t *pWidth, uint32_t *pHeight);
    boost::shared_ptr<webrtc::VideoFrame> loadImage(const std::string &url);

private:
    uint8_t m_size;

    std::map<uint8_t, std::string> m_inputs;
    std::map<std::string, boost::shared_ptr<webrtc::VideoFrame>> m_frames;

    boost::shared_mutex m_mutex;
};

class SoftInput {
    DECLARE_LOGGER();

public:
    SoftInput();
    ~SoftInput();

    void setActive(bool active);
    bool isActive(void);

    void pushInput(webrtc::VideoFrame *videoFrame);
    boost::shared_ptr<webrtc::VideoFrame> popInput();

private:
    bool m_active;
    boost::shared_ptr<webrtc::VideoFrame> m_busyFrame;
    boost::shared_mutex m_mutex;

    boost::scoped_ptr<woogeen_base::I420BufferManager> m_bufferManager;

    boost::scoped_ptr<woogeen_base::FrameConverter> m_converter;
};

class SoftFrameGenerator : public JobTimerListener
{
    DECLARE_LOGGER();

    const uint32_t kMsToRtpTimestamp = 90;

    struct Output_t {
        uint32_t width;
        uint32_t height;
        uint32_t fps;
        woogeen_base::FrameDestination *dest;
    };

public:
    SoftFrameGenerator(
            SoftVideoCompositor *owner,
            woogeen_base::VideoSize &size,
            woogeen_base::YUVColor &bgColor,
            const bool crop,
            const uint32_t maxFps,
            const uint32_t minFps);

    ~SoftFrameGenerator();

    void updateLayoutSolution(LayoutSolution& solution);

    bool isSupported(uint32_t width, uint32_t height, uint32_t fps);

    bool addOutput(const uint32_t width, const uint32_t height, const uint32_t fps, woogeen_base::FrameDestination *dst);
    bool removeOutput(woogeen_base::FrameDestination *dst);

    void onTimeout() override;

protected:
    rtc::scoped_refptr<webrtc::VideoFrameBuffer> generateFrame();
    rtc::scoped_refptr<webrtc::VideoFrameBuffer> layout();

    void reconfigureIfNeeded();

public:
    const webrtc::Clock *m_clock;

    SoftVideoCompositor *m_owner;
    uint32_t m_maxSupportedFps;
    uint32_t m_minSupportedFps;

    uint32_t m_counter;
    uint32_t m_counterMax;

    std::vector<std::list<Output_t>>    m_outputs;
    boost::shared_mutex                 m_outputMutex;

    // configure
    woogeen_base::VideoSize     m_size;
    woogeen_base::YUVColor      m_bgColor;
    bool                        m_crop;

    // reconfifure
    LayoutSolution              m_layout;
    LayoutSolution              m_newLayout;
    bool                        m_configureChanged;
    boost::shared_mutex         m_configMutex;

    boost::scoped_ptr<woogeen_base::I420BufferManager> m_bufferManager;

    boost::scoped_ptr<JobTimer> m_jobTimer;
};

/**
 * composite a sequence of frames into one frame based on current layout config,
 * In the future, we may enable the video rotation based on VAD history.
 */
class SoftVideoCompositor : public VideoFrameCompositor {
    DECLARE_LOGGER();

    friend class SoftFrameGenerator;

public:
    SoftVideoCompositor(uint32_t maxInput, woogeen_base::VideoSize rootSize, woogeen_base::YUVColor bgColor, bool crop);
    ~SoftVideoCompositor();

    bool activateInput(int input);
    void deActivateInput(int input);
    bool setAvatar(int input, const std::string& avatar);
    bool unsetAvatar(int input);
    void pushInput(int input, const woogeen_base::Frame&);

    void updateRootSize(woogeen_base::VideoSize& rootSize);
    void updateBackgroundColor(woogeen_base::YUVColor& bgColor);
    void updateLayoutSolution(LayoutSolution& solution);

    bool addOutput(const uint32_t width, const uint32_t height, const uint32_t framerateFPS, woogeen_base::FrameDestination *dst) override;
    bool removeOutput(woogeen_base::FrameDestination *dst) override;

protected:
    boost::shared_ptr<webrtc::VideoFrame> getInputFrame(int index);

private:
    uint32_t m_maxInput;

    std::vector<boost::shared_ptr<SoftFrameGenerator>> m_generators;

    std::vector<boost::shared_ptr<SoftInput>> m_inputs;
    boost::scoped_ptr<AvatarManager> m_avatarManager;
};

}
#endif /* SoftVideoCompositor_h*/
