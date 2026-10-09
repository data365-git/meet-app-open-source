import { useRive } from "@rive-app/react-canvas";
import { useTranslations } from "next-intl";
import { useTheme } from "../../Contexts";
import { UploadCapButton } from "./UploadCapButton";
import { WebRecorderDialog } from "./web-recorder-dialog/web-recorder-dialog";

interface EmptyCapStateProps {
  userName?: string;
}

export const EmptyCapState: React.FC<EmptyCapStateProps> = () => {
  const t = useTranslations("library");
  const { theme } = useTheme();
  const { RiveComponent: EmptyCap } = useRive({
    src: "/rive/main.riv",
    artboard: theme === "light" ? "empty" : "darkempty",
    autoplay: true,
  });

  return (
    <div className="flex flex-col flex-1 justify-center items-center w-full h-full">
      <div className="flex flex-col gap-3 justify-center items-center h-full text-center">
        <div className="mx-auto w-full mb-10 max-w-[450px] flex justify-center items-center">
          <EmptyCap key={`${theme}empty-cap`} className="h-[150px] w-[400px]" />
        </div>
        <div className="flex flex-col items-center px-5">
          <p className="mb-1 text-[18px] font-bold text-gray-12">
            {t("emptyCapsTitle")}
          </p>
          <p className="max-w-[400px] text-[13.5px] text-gray-10">
            {t("emptyCapsSubtitle")}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 justify-center items-center mt-4">
          <WebRecorderDialog />
          <p className="text-sm text-gray-10">{t("or")}</p>
          <UploadCapButton />
        </div>
      </div>
    </div>
  );
};
